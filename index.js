const express = require('express');
const cors = require('cors');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3001;

// 中間件
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 健康檢查
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'PDF Form Generator',
    version: '1.0.0',
    endpoints: {
      health: 'GET /',
      detectUnderscores: 'POST /detect-underscores',
      createFormFields: 'POST /create-form-fields',
      fullProcess: 'POST /process'
    }
  });
});

// === 工具函數 ===

// 根據字體名稱獲取平均字符寬度係數
function getFontWidthFactor(fontName) {
  const factors = {
    'Helvetica': 0.55,
    'Helvetica-Bold': 0.58,
    'Times': 0.48,
    'Times-Roman': 0.48,
    'Times-Bold': 0.52,
    'Courier': 0.6,
    'Courier-Bold': 0.6,
    'Arial': 0.55,
    'Arial-Bold': 0.58
  };
  
  // 如果找不到，使用預設值
  for (const key in factors) {
    if (fontName && fontName.includes(key)) {
      return factors[key];
    }
  }
  
  return 0.55; // 預設值
}

// 計算字符寬度
function getCharWidth(fontName, fontSize) {
  const factor = getFontWidthFactor(fontName);
  return fontSize * factor;
}

// 找出所有連續下劃線段落
function findUnderscoreSegments(text, minLength = 3) {
  const segments = [];
  let inUnderscore = false;
  let startIndex = 0;
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '_' && !inUnderscore) {
      // 開始一段下劃線
      inUnderscore = true;
      startIndex = i;
    } else if (text[i] !== '_' && inUnderscore) {
      // 結束一段下劃線
      inUnderscore = false;
      
      // 過濾太短的下劃線
      if (i - startIndex >= minLength) {
        segments.push({
          startIndex: startIndex,
          endIndex: i - 1,
          length: i - startIndex
        });
      }
    }
  }
  
  // 處理文字結尾是下劃線的情況
  if (inUnderscore && text.length - startIndex >= minLength) {
    segments.push({
      startIndex: startIndex,
      endIndex: text.length - 1,
      length: text.length - startIndex
    });
  }
  
  return segments;
}

// 獲取上下文（用於生成欄位名稱和問題）
function getContext(text, startIndex, endIndex) {
  const beforeStart = Math.max(0, startIndex - 100);
  const afterEnd = Math.min(text.length, endIndex + 100);
  
  const before = text.substring(beforeStart, startIndex).trim();
  const after = text.substring(endIndex + 1, afterEnd).trim();
  
  return { before, after, full: before + ' _____ ' + after };
}

// 猜測欄位類型
function guessFieldType(context) {
  const beforeLower = context.before.toLowerCase();
  const afterLower = context.after.toLowerCase();
  const combined = (beforeLower + ' ' + afterLower).toLowerCase();
  
  if (combined.includes('date') || combined.includes('day') || combined.includes('month') || combined.includes('year')) {
    return 'date';
  }
  if (combined.includes('name')) {
    return 'name';
  }
  if (combined.includes('address')) {
    return 'address';
  }
  if (combined.includes('phone') || combined.includes('tel')) {
    return 'phone';
  }
  if (combined.includes('email') || combined.includes('e-mail')) {
    return 'email';
  }
  if (combined.includes('$') || combined.includes('amount') || combined.includes('price')) {
    return 'currency';
  }
  if (combined.includes('signature') || combined.includes('sign')) {
    return 'signature';
  }
  
  return 'text';
}

// 生成有意義的欄位名稱
function generateFieldName(context, index) {
  const words = context.before.split(/\s+/).filter(w => w.length > 2);
  const lastWords = words.slice(-3).join('_').replace(/[^a-zA-Z0-9_]/g, '');
  
  if (lastWords) {
    return `field_${index}_${lastWords}`;
  }
  
  return `field_${index}`;
}

// === API 端點 1: 只偵測下劃線（用於測試和檢查） ===
app.post('/detect-underscores', async (req, res) => {
  try {
    const { extract_elements } = req.body;
    
    if (!extract_elements || !Array.isArray(extract_elements)) {
      return res.status(400).json({ error: 'extract_elements array is required' });
    }
    
    console.log(`\n=== Detecting Underscores ===`);
    console.log(`Total elements: ${extract_elements.length}`);
    
    const fillableAreas = [];
    let fieldIndex = 1;
    
    // 遍歷所有 text elements
    for (const element of extract_elements) {
      // 只處理文字元素
      if (!element.Text || typeof element.Text !== 'string') {
        continue;
      }
      
      // 檢查是否包含下劃線
      if (!element.Text.includes('_')) {
        continue;
      }
      
      const text = element.Text;
      const bounds = element.Bounds;
      const page = element.Page || 0;
      const fontSize = element.Font?.size || 12;
      const fontName = element.Font?.name || 'Helvetica';
      
      // 計算字符寬度
      const charWidth = getCharWidth(fontName, fontSize);
      
      // 找出所有下劃線段落
      const segments = findUnderscoreSegments(text);
      
      console.log(`Found ${segments.length} underscore segments in: "${text.substring(0, 50)}..."`);
      
      // 為每個下劃線段落創建填寫區域
      for (const segment of segments) {
        // 計算精確位置
        const startX = bounds[0] + (segment.startIndex * charWidth);
        const width = segment.length * charWidth;
        const height = bounds[3] - bounds[1];
        
        // 獲取上下文
        const context = getContext(text, segment.startIndex, segment.endIndex);
        const fieldType = guessFieldType(context);
        const fieldName = generateFieldName(context, fieldIndex);
        
        fillableAreas.push({
          id: fieldIndex,
          field_name: fieldName,
          page: page,
          bounds: [
            startX,
            bounds[1],
            startX + width,
            bounds[3]
          ],
          x: startX,
          y: bounds[1],
          width: width,
          height: height,
          underscore_length: segment.length,
          context: context,
          field_type: fieldType,
          font_size: fontSize * 0.7, // 欄位字體略小於原文
          original_text: text
        });
        
        fieldIndex++;
      }
    }
    
    console.log(`\n=== Detection Complete ===`);
    console.log(`Total fillable areas found: ${fillableAreas.length}`);
    
    res.json({
      success: true,
      total_areas: fillableAreas.length,
      fillable_areas: fillableAreas
    });
    
  } catch (error) {
    console.error('Error detecting underscores:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// === API 端點 2: 創建表單欄位 ===
app.post('/create-form-fields', async (req, res) => {
  try {
    const { pdf_url, fillable_areas } = req.body;
    
    if (!pdf_url) {
      return res.status(400).json({ error: 'pdf_url is required' });
    }
    
    if (!fillable_areas || !Array.isArray(fillable_areas)) {
      return res.status(400).json({ error: 'fillable_areas array is required' });
    }
    
    console.log(`\n=== Creating Form Fields ===`);
    console.log(`PDF URL: ${pdf_url}`);
    console.log(`Total fields to create: ${fillable_areas.length}`);
    
    // 1. 下載原始 PDF
    const response = await fetch(pdf_url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.statusText}`);
    }
    
    const pdfBuffer = await response.arrayBuffer();
    
    // 2. 載入 PDF
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    
    console.log(`PDF has ${pages.length} pages`);
    
    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    const createdFields = [];
    
    // 3. 為每個填寫區域創建表單欄位
    for (const area of fillable_areas) {
      try {
        const page = pages[area.page];
        if (!page) {
          throw new Error(`Page ${area.page} not found`);
        }
        
        const pageHeight = page.getHeight();
        
        // 創建文字欄位
        const fieldName = area.field_name || `field_${area.id}`;
        const textField = form.createTextField(fieldName);
        
        // 計算字體大小（框高度的 60-70%）
        const fontSize = Math.min(area.height * 0.6, area.font_size || 12);
        
        // 設定欄位屬性
        textField.setText('');
        textField.setFontSize(fontSize);
        textField.enableReadOnly(false);
        textField.enableMultiline(false);
        
        // 添加到頁面（使用 Adobe 的 Y 座標系統）
        textField.addToPage(page, {
          x: area.x,
          y: area.y,
          width: area.width,
          height: area.height,
          borderWidth: 1,
          borderColor: rgb(0.7, 0.7, 0.7),
          backgroundColor: rgb(1, 1, 1),
        });
        
        successCount++;
        createdFields.push({
          id: area.id,
          name: fieldName,
          type: area.field_type,
          page: area.page
        });
        
        if (successCount <= 10 || successCount % 20 === 0) {
          console.log(`✓ [${successCount}] Created: ${fieldName} (${area.field_type})`);
        }
        
      } catch (error) {
        errorCount++;
        const errorMsg = `Failed to create field ${area.field_name}: ${error.message}`;
        errors.push(errorMsg);
        console.error(`✗ ${errorMsg}`);
      }
    }
    
    console.log(`\n=== Form Creation Complete ===`);
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    
    // 4. 儲存帶表單的 PDF
    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');
    
    // 5. 返回結果
    res.json({
      success: true,
      pdf_base64: base64Pdf,
      statistics: {
        total_fields: fillable_areas.length,
        created: successCount,
        errors: errorCount
      },
      created_fields: createdFields,
      error_details: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('Error creating form fields:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// === API 端點 3: 完整流程（偵測 + 創建） ===
app.post('/process', async (req, res) => {
  try {
    const { pdf_url, extract_elements } = req.body;
    
    if (!pdf_url) {
      return res.status(400).json({ error: 'pdf_url is required' });
    }
    
    if (!extract_elements || !Array.isArray(extract_elements)) {
      return res.status(400).json({ error: 'extract_elements array is required' });
    }
    
    console.log(`\n=== Full Process: Detect + Create ===`);
    
    // Step 1: 偵測下劃線
    console.log('Step 1: Detecting underscores...');
    const fillableAreas = [];
    let fieldIndex = 1;
    
    for (const element of extract_elements) {
      if (!element.Text || typeof element.Text !== 'string' || !element.Text.includes('_')) {
        continue;
      }
      
      const text = element.Text;
      const bounds = element.Bounds;
      const page = element.Page || 0;
      const fontSize = element.Font?.size || 12;
      const fontName = element.Font?.name || 'Helvetica';
      
      const charWidth = getCharWidth(fontName, fontSize);
      const segments = findUnderscoreSegments(text);
      
      for (const segment of segments) {
        const startX = bounds[0] + (segment.startIndex * charWidth);
        const width = segment.length * charWidth;
        const context = getContext(text, segment.startIndex, segment.endIndex);
        
        fillableAreas.push({
          id: fieldIndex,
          field_name: generateFieldName(context, fieldIndex),
          page: page,
          x: startX,
          y: bounds[1],
          width: width,
          height: bounds[3] - bounds[1],
          underscore_length: segment.length,
          context: context,
          field_type: guessFieldType(context),
          font_size: fontSize * 0.7
        });
        
        fieldIndex++;
      }
    }
    
    console.log(`Found ${fillableAreas.length} fillable areas`);
    
    // Step 2: 創建表單欄位
    console.log('Step 2: Creating form fields...');
    
    const response = await fetch(pdf_url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.statusText}`);
    }
    
    const pdfBuffer = await response.arrayBuffer();
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    
    let successCount = 0;
    const createdFields = [];
    
    for (const area of fillableAreas) {
      try {
        const page = pages[area.page];
        const textField = form.createTextField(area.field_name);
        
        const fontSize = Math.min(area.height * 0.6, area.font_size || 12);
        textField.setText('');
        textField.setFontSize(fontSize);
        
        textField.addToPage(page, {
          x: area.x,
          y: area.y,
          width: area.width,
          height: area.height,
          borderWidth: 1,
          borderColor: rgb(0.7, 0.7, 0.7),
          backgroundColor: rgb(1, 1, 1),
        });
        
        successCount++;
        createdFields.push({
          id: area.id,
          name: area.field_name,
          type: area.field_type,
          page: area.page,
          context: area.context.full
        });
        
      } catch (error) {
        console.error(`Failed to create field ${area.field_name}:`, error.message);
      }
    }
    
    console.log(`Created ${successCount} form fields`);
    
    // Step 3: 儲存並返回
    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');
    
    res.json({
      success: true,
      pdf_base64: base64Pdf,
      statistics: {
        detected_areas: fillableAreas.length,
        created_fields: successCount
      },
      fields: createdFields
    });
    
  } catch (error) {
    console.error('Error in full process:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`PDF Form Generator running on port ${PORT}`);
  console.log(`Version: 1.0.0`);
});

module.exports = app;

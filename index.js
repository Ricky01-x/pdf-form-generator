const express = require('express');
const cors = require('cors');
const { PDFDocument, rgb, StandardFonts, PDFName, PDFString } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'PDF Form Generator',
    version: '1.1.0',
    endpoints: {
      health: 'GET /',
      detectUnderscores: 'POST /detect-underscores',
      createFormFields: 'POST /create-form-fields',
      fullProcess: 'POST /process'
    }
  });
});

// === 工具函數 ===

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
    'Arial-Bold': 0.58,
    'Arial,Bold': 0.58
  };
  
  for (const key in factors) {
    if (fontName && fontName.includes(key)) {
      return factors[key];
    }
  }
  
  return 0.55;
}

function getCharWidth(fontName, fontSize) {
  const factor = getFontWidthFactor(fontName);
  return fontSize * factor;
}

function findUnderscoreSegments(text, minLength = 3) {
  const segments = [];
  let inUnderscore = false;
  let startIndex = 0;
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '_' && !inUnderscore) {
      inUnderscore = true;
      startIndex = i;
    } else if (text[i] !== '_' && inUnderscore) {
      inUnderscore = false;
      
      if (i - startIndex >= minLength) {
        segments.push({
          startIndex: startIndex,
          endIndex: i - 1,
          length: i - startIndex
        });
      }
    }
  }
  
  if (inUnderscore && text.length - startIndex >= minLength) {
    segments.push({
      startIndex: startIndex,
      endIndex: text.length - 1,
      length: text.length - startIndex
    });
  }
  
  return segments;
}

function getContext(text, startIndex, endIndex) {
  const beforeStart = Math.max(0, startIndex - 100);
  const afterEnd = Math.min(text.length, endIndex + 100);
  
  const before = text.substring(beforeStart, startIndex).trim();
  const after = text.substring(endIndex + 1, afterEnd).trim();
  
  return { before, after, full: before + ' _____ ' + after };
}

function guessFieldType(context) {
  const beforeLower = context.before.toLowerCase();
  const afterLower = context.after.toLowerCase();
  const combined = (beforeLower + ' ' + afterLower).toLowerCase();
  
  if (combined.includes('date') || combined.includes('day') || combined.includes('month') || combined.includes('year')) {
    return 'date';
  }
  if (combined.includes('name')) return 'name';
  if (combined.includes('address')) return 'address';
  if (combined.includes('phone') || combined.includes('tel')) return 'phone';
  if (combined.includes('email') || combined.includes('e-mail')) return 'email';
  if (combined.includes('$') || combined.includes('amount') || combined.includes('price')) return 'currency';
  if (combined.includes('signature') || combined.includes('sign')) return 'signature';
  
  return 'text';
}

function generateFieldName(context, index) {
  const words = context.before.split(/\s+/).filter(w => w.length > 2);
  const lastWords = words.slice(-3).join('_').replace(/[^a-zA-Z0-9_]/g, '');
  
  if (lastWords) {
    return `field_${index}_${lastWords}`;
  }
  
  return `field_${index}`;
}

// === API 端點 ===

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
    
    for (const element of extract_elements) {
      if (!element.Text || typeof element.Text !== 'string') {
        continue;
      }
      
      if (!element.Text.includes('_')) {
        continue;
      }
      
      const text = element.Text;
      const bounds = element.Bounds;
      const page = element.Page || 0;
      
      // 從 Font 物件取得資訊
      const fontSize = element.Font?.size || element.TextSize || 12;
      const fontName = element.Font?.name || element.Font?.family_name || 'Arial';
      
      const charWidth = getCharWidth(fontName, fontSize);
      const segments = findUnderscoreSegments(text);
      
      console.log(`Found ${segments.length} segments in element on page ${page}`);
      
      for (const segment of segments) {
        const startX = bounds[0] + (segment.startIndex * charWidth);
        const width = segment.length * charWidth;
        const height = bounds[3] - bounds[1];
        
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
          font_size: fontSize * 0.7,
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
      const fontSize = element.Font?.size || element.TextSize || 12;
      const fontName = element.Font?.name || element.Font?.family_name || 'Arial';
      
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
    
    if (fillableAreas.length === 0) {
      return res.json({
        success: true,
        pdf_base64: null,
        statistics: {
          detected_areas: 0,
          created_fields: 0
        },
        fields: [],
        message: 'No underscores found in PDF'
      });
    }
    
    // Step 2: 創建表單欄位
    console.log('Step 2: Creating form fields...');
    
    const response = await fetch(pdf_url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.statusText}`);
    }
    
    const pdfBuffer = await response.arrayBuffer();
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    
    // 嵌入標準字體（Helvetica 一定可用）
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const form = pdfDoc.getForm();
    
    let successCount = 0;
    let errorCount = 0;
    const createdFields = [];
    const errors = [];
    
    for (const area of fillableAreas) {
      try {
        const page = pages[area.page];
        if (!page) {
          throw new Error(`Page ${area.page} not found`);
        }
        
        const pageHeight = page.getHeight();
        const pageWidth = page.getWidth();
        
        // 安全座標
        let safeX = area.x;
        let safeY = area.y;
        let safeWidth = area.width;
        let safeHeight = area.height;
        
        // 確保在頁面範圍內
        if (safeX < 0) safeX = 0;
        if (safeY < 0) safeY = 0;
        if (safeX + safeWidth > pageWidth) safeWidth = pageWidth - safeX;
        if (safeY + safeHeight > pageHeight) safeHeight = pageHeight - safeY;
        if (safeWidth < 10) safeWidth = 10;
        if (safeHeight < 5) safeHeight = 5;
        
        const fieldName = `field_${area.id}`;
        
        // 創建文字欄位
        const textField = form.createTextField(fieldName);
        textField.setText('');
        
        // 計算合適的字體大小
        const fontSize = Math.max(6, Math.min(safeHeight * 0.6, 12));
        
        // === 關鍵修正：直接設定 DA (Default Appearance) ===
        const acroField = textField.acroField;
        const defaultAppearance = `0 0 0 rg /Helv ${fontSize} Tf`;
        acroField.dict.set(PDFName.of('DA'), PDFString.of(defaultAppearance));
        
        // 添加到頁面
        textField.addToPage(page, {
          x: safeX,
          y: safeY,
          width: safeWidth,
          height: safeHeight,
          borderWidth: 1,
          borderColor: rgb(0.7, 0.7, 0.7),
          backgroundColor: rgb(1, 1, 1),
        });
        
        // 嘗試更新外觀（可能失敗但不影響）
        try {
          textField.updateAppearances(helveticaFont);
        } catch (e) {
          // 忽略外觀更新錯誤
        }
        
        successCount++;
        createdFields.push({
          id: area.id,
          name: fieldName,
          type: area.field_type,
          page: area.page,
          bounds: [safeX, safeY, safeX + safeWidth, safeY + safeHeight],
          context: area.context.full.substring(0, 100)
        });
        
        if (successCount <= 10 || successCount % 50 === 0) {
          console.log(`✓ [${successCount}/${fillableAreas.length}] ${fieldName}`);
        }
        
      } catch (error) {
        errorCount++;
        errors.push(`field_${area.id}: ${error.message}`);
        console.error(`✗ field_${area.id}: ${error.message}`);
      }
    }
    
    console.log(`\n=== Results ===`);
    console.log(`Created: ${successCount}/${fillableAreas.length}`);
    console.log(`Errors: ${errorCount}`);
    
    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');
    
    res.json({
      success: true,
      pdf_base64: base64Pdf,
      statistics: {
        detected_areas: fillableAreas.length,
        created_fields: successCount,
        errors: errorCount
      },
      fields: createdFields,
      error_details: errors.length > 0 ? errors.slice(0, 10) : undefined
    });
    
  } catch (error) {
    console.error('Error in full process:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

app.listen(PORT, () => {
  console.log(`PDF Form Generator running on port ${PORT}`);
  console.log(`Version: 1.1.0`);
});

module.exports = app;
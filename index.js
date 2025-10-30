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
    version: '2.1.0',
    features: [
      'Accurate multi-field positioning',
      'Multiline text merging',
      'Checkbox detection',
      'Improved coordinate calculation'
    ],
    endpoints: {
      health: 'GET /',
      detectUnderscores: 'POST /detect-underscores',
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

// === 改進：精確計算字符位置 ===
function calculateCharacterPositions(text, startX, fontName, fontSize) {
  const positions = [];
  const charWidth = getCharWidth(fontName, fontSize);
  let currentX = startX;
  
  for (let i = 0; i < text.length; i++) {
    positions.push(currentX);
    
    // 不同字符可能有不同寬度，但我們用平均值
    // 特殊處理：空格
    if (text[i] === ' ') {
      currentX += charWidth * 0.3; // 空格較窄
    } else {
      currentX += charWidth;
    }
  }
  
  return positions;
}

// === 改進：智能下劃線分段 ===
function findUnderscoreSegments(text, minLength = 3) {
  const segments = [];
  let inUnderscore = false;
  let startIndex = 0;
  let consecutiveNonUnderscore = 0;
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '_') {
      if (!inUnderscore) {
        inUnderscore = true;
        startIndex = i;
      }
      consecutiveNonUnderscore = 0;
    } else {
      consecutiveNonUnderscore++;
      
      // 斷點檢測：超過 2 個非下劃線字符 = 新段落
      // 降低閾值讓分段更敏感
      if (inUnderscore && consecutiveNonUnderscore >= 2) {
        inUnderscore = false;
        
        const length = i - consecutiveNonUnderscore - startIndex;
        if (length >= minLength) {
          segments.push({
            startIndex: startIndex,
            endIndex: i - consecutiveNonUnderscore - 1,
            length: length,
            type: 'text'
          });
        }
      }
    }
  }
  
  // 處理結尾
  if (inUnderscore) {
    const length = text.length - consecutiveNonUnderscore - startIndex;
    if (length >= minLength) {
      segments.push({
        startIndex: startIndex,
        endIndex: text.length - consecutiveNonUnderscore - 1,
        length: length,
        type: 'text'
      });
    }
  }
  
  return segments;
}

// === Checkbox 識別 ===
function detectCheckboxes(text) {
  const checkboxes = [];
  
  const checkboxPatterns = [
    { regex: /☐/g, type: 'checkbox' },
    { regex: /□/g, type: 'checkbox' },
    { regex: /\[\s*\]/g, type: 'checkbox' },
    { regex: /\(\s*\)/g, type: 'radio' }
  ];
  
  for (const pattern of checkboxPatterns) {
    let match;
    const regex = new RegExp(pattern.regex);
    while ((match = regex.exec(text)) !== null) {
      checkboxes.push({
        type: pattern.type,
        index: match.index,
        symbol: match[0]
      });
    }
  }
  
  return checkboxes;
}

// === 跨行文字合併 ===
function mergeMultilineElements(elements) {
  const merged = [];
  let currentMerge = null;
  
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    
    if (!element.Text || typeof element.Text !== 'string') {
      if (currentMerge) {
        merged.push(currentMerge);
        currentMerge = null;
      }
      continue;
    }
    
    const hasUnderscore = element.Text.includes('_');
    const hasCheckbox = /[☐□\[\]\(\)]/.test(element.Text);
    
    if (!hasUnderscore && !hasCheckbox) {
      if (currentMerge) {
        merged.push(currentMerge);
        currentMerge = null;
      }
      continue;
    }
    
    if (currentMerge && element.Page === currentMerge.Page) {
      const prevBounds = currentMerge.Bounds;
      const currBounds = element.Bounds;
      
      const yDiff = Math.abs(currBounds[1] - prevBounds[1]);
      const xGap = currBounds[0] - prevBounds[2];
      
      if (yDiff < 20 && xGap >= 0 && xGap < 100) {
        currentMerge.Text += ' ' + element.Text;
        currentMerge.Bounds[2] = currBounds[2];
        currentMerge.Bounds[3] = Math.max(prevBounds[3], currBounds[3]);
        currentMerge.Bounds[1] = Math.min(prevBounds[1], currBounds[1]);
        continue;
      }
    }
    
    if (currentMerge) {
      merged.push(currentMerge);
    }
    
    currentMerge = {
      Text: element.Text,
      Bounds: [...element.Bounds],
      Page: element.Page,
      Font: element.Font,
      TextSize: element.TextSize
    };
  }
  
  if (currentMerge) {
    merged.push(currentMerge);
  }
  
  console.log(`Merged ${elements.length} elements into ${merged.length} elements`);
  
  return merged;
}

function getContext(text, startIndex, endIndex) {
  const beforeStart = Math.max(0, startIndex - 100);
  const afterEnd = Math.min(text.length, endIndex + 100);
  
  const before = text.substring(beforeStart, startIndex).trim();
  const after = text.substring(endIndex + 1, afterEnd).trim();
  
  return { before, after, full: before + ' _____ ' + after };
}

function guessFieldType(context, text = '') {
  const beforeLower = context.before.toLowerCase();
  const afterLower = context.after.toLowerCase();
  const combined = (beforeLower + ' ' + afterLower + ' ' + text).toLowerCase();
  
  // 移除簽名欄位自動識別
  
  if (combined.includes('date') || combined.includes('day') || 
      combined.includes('month') || combined.includes('year')) {
    return 'date';
  }
  
  if (combined.includes('name')) return 'name';
  if (combined.includes('address')) return 'address';
  if (combined.includes('phone') || combined.includes('tel')) return 'phone';
  if (combined.includes('email') || combined.includes('e-mail')) return 'email';
  if (combined.includes('$') || combined.includes('amount') || combined.includes('price')) return 'currency';
  
  return 'text';
}

function generateFieldName(context, index, fieldType) {
  if (fieldType === 'checkbox' || fieldType === 'radio') {
    return `${fieldType}_${index}`;
  }
  
  const words = context.before.split(/\s+/).filter(w => w.length > 2);
  const lastWords = words.slice(-3).join('_').replace(/[^a-zA-Z0-9_]/g, '');
  
  if (lastWords) {
    return `field_${index}_${lastWords}`;
  }
  
  return `field_${index}`;
}

// === API 端點 ===

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
    
    // Step 1: 合併跨行元素
    console.log('Step 1: Merging multiline elements...');
    const mergedElements = mergeMultilineElements(extract_elements);
    
    // Step 2: 偵測所有欄位
    console.log('Step 2: Detecting all form fields...');
    const fillableAreas = [];
    let fieldIndex = 1;
    
    for (const element of mergedElements) {
      const text = element.Text;
      const bounds = element.Bounds;
      const page = element.Page || 0;
      const fontSize = element.Font?.size || element.TextSize || 12;
      const fontName = element.Font?.name || element.Font?.family_name || 'Arial';
      
      // === 關鍵改進：計算每個字符的精確位置 ===
      const charPositions = calculateCharacterPositions(text, bounds[0], fontName, fontSize);
      const charWidth = getCharWidth(fontName, fontSize);
      
      // 檢測 Checkbox/Radio
      const checkboxes = detectCheckboxes(text);
      
      for (const checkbox of checkboxes) {
        // 使用精確的字符位置
        const startX = charPositions[checkbox.index] || bounds[0];
        const size = fontSize * 0.9;
        
        fillableAreas.push({
          id: fieldIndex,
          field_name: `${checkbox.type}_${fieldIndex}`,
          page: page,
          x: startX,
          y: bounds[1],
          width: size,
          height: size,
          field_type: checkbox.type,
          context: {
            before: text.substring(Math.max(0, checkbox.index - 50), checkbox.index),
            after: text.substring(checkbox.index + checkbox.symbol.length, Math.min(text.length, checkbox.index + 100)),
            full: text
          },
          font_size: fontSize
        });
        
        fieldIndex++;
      }
      
      // 檢測下劃線
      if (text.includes('_')) {
        const segments = findUnderscoreSegments(text);
        
        for (const segment of segments) {
          // === 關鍵改進：使用精確的字符位置 ===
          const startX = charPositions[segment.startIndex] || bounds[0];
          const endX = charPositions[segment.endIndex] || (startX + segment.length * charWidth);
          const width = endX - startX;
          
          const context = getContext(text, segment.startIndex, segment.endIndex);
          const fieldType = guessFieldType(context, text);
          
          fillableAreas.push({
            id: fieldIndex,
            field_name: generateFieldName(context, fieldIndex, fieldType),
            page: page,
            x: startX,
            y: bounds[1],
            width: width,
            height: bounds[3] - bounds[1],
            field_type: fieldType,
            context: context,
            font_size: fontSize * 0.7
          });
          
          fieldIndex++;
        }
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
        message: 'No form fields found in PDF'
      });
    }
    
    // Step 3: 創建表單欄位
    console.log('Step 3: Creating form fields...');
    
    const response = await fetch(pdf_url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.statusText}`);
    }
    
    const pdfBuffer = await response.arrayBuffer();
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
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
        
        // 安全座標檢查
        let safeX = Math.max(0, Math.min(area.x, pageWidth - 10));
        let safeY = Math.max(0, Math.min(area.y, pageHeight - 5));
        let safeWidth = Math.max(10, Math.min(area.width, pageWidth - safeX));
        let safeHeight = Math.max(5, Math.min(area.height, pageHeight - safeY));
        
        // 根據欄位類型創建
        if (area.field_type === 'checkbox') {
          const checkbox = form.createCheckBox(area.field_name);
          
          checkbox.addToPage(page, {
            x: safeX,
            y: safeY,
            width: safeWidth,
            height: safeHeight,
            borderWidth: 1,
            borderColor: rgb(0, 0, 0),
          });
          
          successCount++;
          createdFields.push({
            id: area.id,
            name: area.field_name,
            type: 'checkbox',
            page: area.page
          });
          
        } else if (area.field_type === 'radio') {
          const radioGroup = form.createRadioGroup(area.field_name);
          
          radioGroup.addOptionToPage('option1', page, {
            x: safeX,
            y: safeY,
            width: safeWidth,
            height: safeHeight,
            borderWidth: 1,
            borderColor: rgb(0, 0, 0),
          });
          
          successCount++;
          createdFields.push({
            id: area.id,
            name: area.field_name,
            type: 'radio',
            page: area.page
          });
          
        } else {
          // 文字欄位
          const textField = form.createTextField(area.field_name);
          textField.setText('');
          
          const fontSize = Math.max(6, Math.min(safeHeight * 0.6, 12));
          
          const acroField = textField.acroField;
          const defaultAppearance = `0 0 0 rg /Helv ${fontSize} Tf`;
          acroField.dict.set(PDFName.of('DA'), PDFString.of(defaultAppearance));
          
          textField.addToPage(page, {
            x: safeX,
            y: safeY,
            width: safeWidth,
            height: safeHeight,
            borderWidth: 1,
            borderColor: rgb(0.7, 0.7, 0.7),
            backgroundColor: rgb(1, 1, 1),
          });
          
          try {
            textField.updateAppearances(helveticaFont);
          } catch (e) {
            // 忽略
          }
          
          successCount++;
          createdFields.push({
            id: area.id,
            name: area.field_name,
            type: area.field_type,
            page: area.page,
            bounds: [safeX, safeY, safeX + safeWidth, safeY + safeHeight],
            context: typeof area.context === 'object' ? area.context.full?.substring(0, 100) : ''
          });
        }
        
        if (successCount <= 10 || successCount % 50 === 0) {
          console.log(`✓ [${successCount}/${fillableAreas.length}] ${area.field_name} (${area.field_type})`);
        }
        
      } catch (error) {
        errorCount++;
        errors.push(`${area.field_name}: ${error.message}`);
        console.error(`✗ ${area.field_name}: ${error.message}`);
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
        errors: errorCount,
        text_fields: createdFields.filter(f => !['checkbox', 'radio'].includes(f.type)).length,
        checkboxes: createdFields.filter(f => f.type === 'checkbox').length,
        radio_buttons: createdFields.filter(f => f.type === 'radio').length
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
  console.log(`Version: 2.1.0`);
});

module.exports = app;
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
    version: '2.3.1',
    features: [
      'Improved long-text field positioning',
      'Three-color field system (signature, currency, text)',
      'Better character position calculation',
      'Support for 2+ underscores'
    ],
    endpoints: {
      health: 'GET /',
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
    'Arial': 0.52,
    'Arial-Bold': 0.55,
    'Arial,Bold': 0.55
  };
  
  for (const key in factors) {
    if (fontName && fontName.includes(key)) {
      return factors[key];
    }
  }
  
  return 0.52;
}

function getCharWidth(fontName, fontSize) {
  const factor = getFontWidthFactor(fontName);
  return fontSize * factor;
}

// === 改進：更精確的字符位置計算 ===
function calculateCharacterPositions(text, startX, fontName, fontSize) {
  const positions = [];
  const baseCharWidth = getCharWidth(fontName, fontSize);
  let currentX = startX;
  
  for (let i = 0; i < text.length; i++) {
    positions.push(currentX);
    
    const char = text[i];
    
    // 特殊字符寬度
    if (char === ' ') {
      currentX += baseCharWidth * 0.3;
    } else if (char === '_') {
      currentX += baseCharWidth * 0.5; // 下劃線較窄
    } else if (char === '(' || char === ')') {
      currentX += baseCharWidth * 0.35;
    } else if (char === '$') {
      currentX += baseCharWidth * 0.6;
    } else if (char === '.') {
      currentX += baseCharWidth * 0.25;
    } else if (char === ',') {
      currentX += baseCharWidth * 0.3;
    } else if (char === ':') {
      currentX += baseCharWidth * 0.3;
    } else {
      currentX += baseCharWidth;
    }
  }
  
  return positions;
}

// === 改進：更智能的下劃線分段 ===
function findUnderscoreSegments(text, minLength = 2) {
  const segments = [];
  let i = 0;
  
  while (i < text.length) {
    if (text[i] === '_') {
      const startIndex = i;
      let count = 0;
      
      // 計算連續下劃線（允許中間有空格）
      while (i < text.length && (text[i] === '_' || text[i] === ' ')) {
        if (text[i] === '_') count++;
        i++;
      }
      
      if (count >= minLength) {
        segments.push({
          startIndex: startIndex,
          endIndex: i - 1,
          length: count
        });
      }
    } else {
      i++;
    }
  }
  
  return segments;
}

// === Checkbox 檢測 ===
function detectCheckboxes(text) {
  const checkboxes = [];
  
  const patterns = [
    { regex: /☐/g, type: 'checkbox' },
    { regex: /□/g, type: 'checkbox' },
    { regex: /\[\s*\]/g, type: 'checkbox' },
    { regex: /\(\s*\)/g, type: 'radio' }
  ];
  
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern.regex)];
    for (const match of matches) {
      checkboxes.push({
        type: pattern.type,
        index: match.index,
        symbol: match[0],
        length: match[0].length
      });
    }
  }
  
  checkboxes.sort((a, b) => a.index - b.index);
  return checkboxes;
}

// === 改進：更激進的跨行合併 ===
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
      
      // 更寬鬆的合併條件
      const canMerge = 
        yDiff < 40 &&          // 增加到 40
        xGap >= -20 &&         // 允許更多重疊
        xGap < 200;            // 增加到 200
      
      if (canMerge) {
        const needSpace = !currentMerge.Text.endsWith(' ') && !element.Text.startsWith(' ');
        currentMerge.Text += (needSpace ? ' ' : '') + element.Text;
        
        // 更新邊界（保留最左和最右）
        currentMerge.Bounds[0] = Math.min(prevBounds[0], currBounds[0]);
        currentMerge.Bounds[2] = Math.max(prevBounds[2], currBounds[2]);
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
  const beforeStart = Math.max(0, startIndex - 50);
  const afterEnd = Math.min(text.length, endIndex + 50);
  
  const before = text.substring(beforeStart, startIndex).trim();
  const after = text.substring(endIndex + 1, afterEnd).trim();
  
  return { before, after, full: before + ' _____ ' + after };
}

// === 簡化：只區分 3 種類型 ===
function guessFieldType(context, text = '') {
  const beforeLower = context.before.toLowerCase();
  const afterLower = context.after.toLowerCase();
  const combined = (beforeLower + ' ' + afterLower + ' ' + text).toLowerCase();
  
  // 1. 簽名欄位（藍色）
  if (combined.includes('sign') || combined.includes('signature')) {
    return 'signature';
  }
  
  // 2. 金額欄位（綠色）
  if (combined.includes('$') || combined.includes('amount') || 
      combined.includes('sum of') || combined.includes('price')) {
    return 'currency';
  }
  
  // 3. 一般欄位（灰色）
  return 'text';
}

function generateFieldName(context, index, fieldType) {
  if (fieldType === 'checkbox' || fieldType === 'radio') {
    return `${fieldType}_${index}`;
  }
  
  const words = context.before.split(/\s+/).filter(w => w.length > 2);
  const lastWords = words.slice(-2).join('_').replace(/[^a-zA-Z0-9_]/g, '');
  
  if (lastWords) {
    return `${fieldType}_${index}_${lastWords}`;
  }
  
  return `${fieldType}_${index}`;
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
    
    console.log(`\n=== Processing PDF v2.3.1 ===`);
    
    // Step 1: 合併
    const mergedElements = mergeMultilineElements(extract_elements);
    
    // Step 2: 偵測
    const fillableAreas = [];
    let fieldIndex = 1;
    
    for (const element of mergedElements) {
      const text = element.Text;
      const bounds = element.Bounds;
      const page = element.Page || 0;
      const fontSize = element.Font?.size || element.TextSize || 12;
      const fontName = element.Font?.name || element.Font?.family_name || 'Arial';
      
      const charPositions = calculateCharacterPositions(text, bounds[0], fontName, fontSize);
      const charWidth = getCharWidth(fontName, fontSize);
      
      // Checkbox
      const checkboxes = detectCheckboxes(text);
      for (const checkbox of checkboxes) {
        const startX = charPositions[checkbox.index] || bounds[0];
        const size = fontSize * 0.85;
        
        fillableAreas.push({
          id: fieldIndex,
          field_name: `${checkbox.type}_${fieldIndex}`,
          page: page,
          x: startX,
          y: bounds[1],
          width: size,
          height: size,
          field_type: checkbox.type,
          context: { before: '', after: '', full: text },
          font_size: fontSize
        });
        
        fieldIndex++;
      }
      
      // 下劃線
      if (text.includes('_')) {
        const segments = findUnderscoreSegments(text, 2);
        
        for (const segment of segments) {
          const startX = charPositions[segment.startIndex] || bounds[0];
          const endIndex = Math.min(segment.endIndex, charPositions.length - 1);
          const endX = charPositions[endIndex] || (startX + segment.length * charWidth);
          const width = Math.max(endX - startX, 30);
          
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
        statistics: { detected_areas: 0, created_fields: 0 },
        fields: [],
        message: 'No form fields found'
      });
    }
    
    // Step 3: 創建表單
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
        if (!page) throw new Error(`Page ${area.page} not found`);
        
        const pageHeight = page.getHeight();
        const pageWidth = page.getWidth();
        
        let safeX = Math.max(0, Math.min(area.x, pageWidth - 10));
        let safeY = Math.max(0, Math.min(area.y, pageHeight - 5));
        let safeWidth = Math.max(10, Math.min(area.width, pageWidth - safeX));
        let safeHeight = Math.max(5, Math.min(area.height, pageHeight - safeY));
        
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
          // 文字欄位 - 只有 3 種顏色
          const textField = form.createTextField(area.field_name);
          textField.setText('');
          
          const fontSize = Math.max(6, Math.min(safeHeight * 0.6, 12));
          
          const acroField = textField.acroField;
          const defaultAppearance = `0 0 0 rg /Helv ${fontSize} Tf`;
          acroField.dict.set(PDFName.of('DA'), PDFString.of(defaultAppearance));
          
          // 簡化：只有 3 種顏色
          let borderColor, backgroundColor;
          
          if (area.field_type === 'signature') {
            borderColor = rgb(0, 0, 1);           // 藍色
            backgroundColor = rgb(0.9, 0.9, 1);
          } else if (area.field_type === 'currency') {
            borderColor = rgb(0, 0.6, 0);         // 綠色
            backgroundColor = rgb(0.9, 1, 0.9);
          } else {
            borderColor = rgb(0.7, 0.7, 0.7);     // 灰色
            backgroundColor = rgb(1, 1, 1);
          }
          
          textField.addToPage(page, {
            x: safeX,
            y: safeY,
            width: safeWidth,
            height: safeHeight,
            borderWidth: 1,
            borderColor: borderColor,
            backgroundColor: backgroundColor,
          });
          
          try {
            textField.updateAppearances(helveticaFont);
          } catch (e) {}
          
          successCount++;
          createdFields.push({
            id: area.id,
            name: area.field_name,
            type: area.field_type,
            page: area.page,
            x: safeX,
            y: safeY,
            width: safeWidth
          });
        }
        
        if (successCount % 50 === 0 || successCount <= 5) {
          console.log(`  ✓ Created ${successCount}/${fillableAreas.length}`);
        }
        
      } catch (error) {
        errorCount++;
        errors.push(`${area.field_name}: ${error.message}`);
        console.error(`  ✗ ${area.field_name}: ${error.message}`);
      }
    }
    
    console.log(`\n=== Results ===`);
    console.log(`Created: ${successCount}/${fillableAreas.length}`);
    console.log(`Errors: ${errorCount}`);
    
    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');
    
    const fieldStats = {
      text: createdFields.filter(f => f.type === 'text').length,
      signature: createdFields.filter(f => f.type === 'signature').length,
      currency: createdFields.filter(f => f.type === 'currency').length,
      checkboxes: createdFields.filter(f => f.type === 'checkbox').length,
      radio_buttons: createdFields.filter(f => f.type === 'radio').length
    };
    
    res.json({
      success: true,
      pdf_base64: base64Pdf,
      statistics: {
        detected_areas: fillableAreas.length,
        created_fields: successCount,
        errors: errorCount,
        ...fieldStats
      },
      fields: createdFields,
      error_details: errors.length > 0 ? errors.slice(0, 10) : undefined
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

app.listen(PORT, () => {
  console.log(`PDF Form Generator running on port ${PORT}`);
  console.log(`Version: 2.3.1`);
});

module.exports = app;
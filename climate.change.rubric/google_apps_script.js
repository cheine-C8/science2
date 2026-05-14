// 1. In your Google Sheet, go to Extensions > Apps Script.
// 2. Delete any existing code and paste this entire file.
// 3. Click "Deploy" > "New deployment" at the top right.
// 4. Select "Web app" as the type.
// 5. Under "Execute as", select "Me".
// 6. Under "Who has access", select "Anyone".
// 7. Click Deploy. (You may need to authorize the app the first time).
// 8. Copy the "Web app URL" and replace the placeholder in your index.html file.

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);
    
    // Check if the sheet is completely empty, and add headers if so
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Timestamp",
        "Student Name", 
        "Period",
        "Evaluator Name", 
        "Total Score", 
        "Intro Hook/Context", 
        "Organization", 
        "Content Development", 
        "Scientific Language", 
        "Creative & Visual Design", 
        "Citations & Credibility", 
        "Conclusion & Insight", 
        "Feedback"
      ]);
      // Make headers bold
      sheet.getRange(1, 1, 1, 13).setFontWeight("bold");
    }
    
    // Add row to sheet
    sheet.appendRow([
      data.date,
      data.studentName,
      data.period, // New field mapped to column C
      data.evaluatorName,
      data.totalScore,
      data.scores[0] || 0, // Intro
      data.scores[1] || 0, // Organization
      data.scores[2] || 0, // Content
      data.scores[3] || 0, // Language
      data.scores[4] || 0, // Design
      data.scores[5] || 0, // Citations
      data.scores[6] || 0, // Conclusion
      data.feedback
    ]);
    
    return ContentService.createTextOutput(JSON.stringify({"status": "success"}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({"status": "error", "message": error.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

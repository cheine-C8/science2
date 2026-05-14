// ==========================================
// CONFIGURATION
// ==========================================
// Replace this with your Google Sheet ID (the long string in the sheet's URL)
const SHEET_ID = '1LJrD8hVOZxcRJejlAKPZZqZwuruiKWwS3uxXMY6pACo'; 

// Optional: The name of the tab in your spreadsheet. If left empty, it will use the first tab.
const SHEET_NAME = '25-26'; 

// Your Google Doc ID
const DOC_ID = '1Uas0E8RNd2FlDbF1O5jZOV0kPyHal2nZlQXvS-WHZbc'; 

// ==========================================
// WEB APP API (For the Control Panel)
// ==========================================
function doGet(e) {
  // Allow cross-origin requests
  const output = ContentService.createTextOutput(JSON.stringify({ status: "ready" }));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function doPost(e) {
  try {
    const action = e.parameter.action;
    
    if (action === "insertJoke") {
      const result = insertJokeOfTheDay();
      return createJsonResponse({ success: true, message: result.message, joke: result.joke });
    } else if (action === "toggleAuto") {
      const enable = e.parameter.enable === "true";
      toggleDailyTrigger(enable);
      return createJsonResponse({ success: true, message: `Auto-insert ${enable ? 'enabled' : 'disabled'}` });
    } else if (action === "toggleStudentName") {
      const enable = e.parameter.enable === "true";
      const props = PropertiesService.getScriptProperties();
      props.setProperty('INCLUDE_STUDENT_NAME', enable.toString());
      return createJsonResponse({ success: true, message: `Student name inclusion ${enable ? 'enabled' : 'disabled'}` });
    } else if (action === "getStatus") {
      const isEnabled = isTriggerEnabled();
      const props = PropertiesService.getScriptProperties();
      const includeStudentName = props.getProperty('INCLUDE_STUDENT_NAME') !== 'false'; // default true
      return createJsonResponse({ success: true, autoEnabled: isEnabled, studentNameEnabled: includeStudentName });
    }
    
    return createJsonResponse({ success: false, message: "Unknown action" });
  } catch (error) {
    return createJsonResponse({ success: false, message: error.message });
  }
}

function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// CORE JOKE LOGIC
// ==========================================

function insertJokeOfTheDay() {
  const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
  
  // Use the specific sheet name if provided, otherwise default to the first sheet
  const sheet = SHEET_NAME ? spreadsheet.getSheetByName(SHEET_NAME) : spreadsheet.getSheets()[0];
  
  if (!sheet) {
    throw new Error(`Could not find the sheet. Please check the SHEET_NAME setting.`);
  }
  
  const data = sheet.getDataRange().getValues();
  
  // Get today's date formatted as MM/DD/YYYY to compare
  const today = new Date();
  const todayString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
  
  let todaysJoke = null;
  let source = null;

  // Assuming headers are on row 1, loop through rows starting at index 1
  for (let i = 1; i < data.length; i++) {
    const rowDate = data[i][0]; // Column A (0-indexed) = Date
    
    // Check if it's a valid date object
    if (rowDate instanceof Date) {
      const rowDateString = `${rowDate.getMonth() + 1}/${rowDate.getDate()}/${rowDate.getFullYear()}`;
      if (rowDateString === todayString) {
        // Col 4 = Notes, Col 5 = Joke
        source = data[i][4];
        todaysJoke = data[i][5];
        break;
      }
    }
  }
  
  if (!todaysJoke) {
    throw new Error(`No joke found for today's date (${todayString}) in the spreadsheet.`);
  }
  
  // Parse the joke into Setup and Punchline
  let setup = todaysJoke;
  let punchline = "";
  
  if (todaysJoke.includes("?")) {
    const parts = todaysJoke.split("?");
    setup = parts[0] + "?";
    punchline = parts.slice(1).join("?").trim();
  } else if (todaysJoke.includes("\n")) {
    const parts = todaysJoke.split("\n");
    setup = parts[0];
    punchline = parts.slice(1).join(" ").trim();
  }
  
  const props = PropertiesService.getScriptProperties();
  const includeStudentName = props.getProperty('INCLUDE_STUDENT_NAME') !== 'false';
  
  if (includeStudentName && source && source.trim() !== "") {
     punchline += `\n(Submitted by: ${source})`;
  }
  
  // Insert into Google Doc
  updateGoogleDoc(setup, punchline);
  
  return {
    message: "Joke successfully inserted into the doc!",
    joke: { setup, punchline }
  };
}

function updateGoogleDoc(newSetup, newPunchline) {
  const doc = DocumentApp.openById(DOC_ID);
  const body = doc.getBody();
  
  const props = PropertiesService.getScriptProperties();
  
  // Try to find the previous joke, fallback to the placeholders
  let targetSetup = props.getProperty('PREVIOUS_SETUP');
  let targetPunchline = props.getProperty('PREVIOUS_PUNCHLINE');
  
  // If the document doesn't contain the previous setup, it means the user manually changed it.
  // We fall back to the {{JOKE_SETUP}} placeholder.
  if (!targetSetup || !body.findText(escapeRegex(targetSetup))) {
    targetSetup = '{{JOKE_SETUP}}';
  }
  if (!targetPunchline || !body.findText(escapeRegex(targetPunchline))) {
    targetPunchline = '{{JOKE_PUNCHLINE}}';
  }
  
  // Perform the replacement
  body.replaceText(escapeRegex(targetSetup), newSetup);
  
  if (newPunchline) {
    body.replaceText(escapeRegex(targetPunchline), newPunchline);
  } else {
     // If there is no punchline, clear the punchline placeholder
     body.replaceText(escapeRegex(targetPunchline), "");
  }
  
  // Save the newly inserted joke to properties for tomorrow's replacement
  props.setProperty('PREVIOUS_SETUP', newSetup);
  props.setProperty('PREVIOUS_PUNCHLINE', newPunchline);
}

// Helper to escape regex characters so replaceText matches exactly
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ==========================================
// TRIGGER MANAGEMENT (For the Toggle)
// ==========================================

function toggleDailyTrigger(enable) {
  // First, remove any existing triggers to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyAutoInsert') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  
  if (enable) {
    // Create a new time-driven trigger to run every day at 6:00 AM
    ScriptApp.newTrigger('dailyAutoInsert')
             .timeBased()
             .everyDays(1)
             .atHour(6)
             .create();
  }
}

function isTriggerEnabled() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyAutoInsert') {
      return true;
    }
  }
  return false;
}

// This is the function that runs automatically every morning
function dailyAutoInsert() {
  try {
    insertJokeOfTheDay();
  } catch (e) {
    console.error("Auto-insert failed: " + e.message);
  }
}

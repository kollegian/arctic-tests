import { google } from "googleapis";
import fs from "fs";

// Adjust these to your setup
const KEY = "prereleasetests-75c3414f24b1.json";
const MOCHA_PATH = "./mochawesome-report/mochawesome.json";

// -------------- MAIN FUNCTION -------------- //
export async function updateSpreadsheet(spreadsheetId: string) {
  const sheets = await authenticate();
  const mochaResults = JSON.parse(fs.readFileSync(MOCHA_PATH, "utf-8"));

  // Determine the sheet name based on the top-level suite, if available
  let sheetName = "Tests";
  if (
    mochaResults.results?.length > 0 &&
    mochaResults.results[0].suites?.length > 0
  ) {
    sheetName = mochaResults.results[0].suites[0].title || "Tests";
  }

  // 2) Recursively extract all test results
  const allTestResults = extractTests(mochaResults.results);
  console.log(allTestResults);

  // 3) Make sure the sheet exists
  const sheetExists = await doesSheetExist(sheets, spreadsheetId, sheetName);
  if (!sheetExists) {
    // Create a new sheet with this name.
    await addSheet(sheets, spreadsheetId, sheetName);
  }

  // 4) Determine which columns to use for this “run”
  const lastUsedCol = await getLastUsedColumnIndex(sheets, spreadsheetId, sheetName);

  const passFailColIndex = lastUsedCol + 1;
  const dateColIndex = lastUsedCol + 2;

  // 5) Get all existing test titles from column A
  const existingTitles = await getExistingTitles(sheets, spreadsheetId, sheetName);

  // Prepare update and new row requests
  const updateRequests: Array<{ range: string; values: any[][] }> = [];
  const newRows: string[][] = [];
  const today = new Date().toISOString().split("T")[0];

  // 6) Update existing tests or append new ones
  for (const test of allTestResults) {
    const rowIndex = existingTitles.indexOf(test.title);
    if (rowIndex !== -1) {
      // Existing test: prepare update requests
      const actualRow = rowIndex + 2; // rowIndex=0 => row2
      const passFailRange = `${sheetName}!${colLetter(passFailColIndex)}${actualRow}`;
      const dateRange = `${sheetName}!${colLetter(dateColIndex)}${actualRow}`;

      updateRequests.push({
        range: passFailRange,
        values: [[test.state]],
      });
      updateRequests.push({
        range: dateRange,
        values: [[today]],
      });
    } else {
      // New test: prepare a new row
      const row = Array(dateColIndex).fill("");
      row[0] = test.title;                           // Column A
      row[passFailColIndex - 1] = test.state;        // Pass/Fail
      row[dateColIndex - 1] = today;                 // Date
      newRows.push(row);
    }
  }

  // 7) Batch update existing rows
  if (updateRequests.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updateRequests.map((u) => ({
          range: u.range,
          values: u.values,
        })),
      },
    });
  }

  // 8) Append new rows
  if (newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:A`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: newRows,
      },
    });
  }

  // 9) Apply data validation and formatting to the new pass/fail column
  await addCheckboxColumn(sheets, spreadsheetId, sheetName, passFailColIndex);
  await addConditionalFormatting(sheets, spreadsheetId, sheetName, passFailColIndex);

  console.log(
    "Done. This run stored pass/fail in column",
    colLetter(passFailColIndex),
    "and the date in",
    colLetter(dateColIndex)
  );
}

// ------------------ HELPERS ------------------ //

// Recursive function to extract all tests from nested suites
function extractTests(results: any[]): { title: string; state: string }[] {
  let tests: { title: string; state: string }[] = [];

  for (const result of results) {
    if (result.suites && Array.isArray(result.suites)) {
      tests = tests.concat(extractTestsFromSuites(result.suites));
    }
  }

  return tests;
}

function extractTestsFromSuites(suites: any[]): { title: string; state: string }[] {
  let tests: { title: string; state: string }[] = [];

  for (const suite of suites) {
    // Extract tests in the current suite
    if (suite.tests && Array.isArray(suite.tests)) {
      const extractedTests = suite.tests.map((t: any) => ({
        title: t.title,
        state: t.state === "passed" ? "TRUE" : "FALSE",
      }));
      tests = tests.concat(extractedTests);
    }

    // Recursively extract tests from nested suites
    if (suite.suites && Array.isArray(suite.suites)) {
      tests = tests.concat(extractTestsFromSuites(suite.suites));
    }
  }

  return tests;
}

async function authenticate() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function doesSheetExist(sheets: any, spreadsheetId: string, sheetName: string): Promise<boolean> {
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  return response.data.sheets?.some((s: any) => s.properties?.title === sheetName);
}

async function addSheet(sheets: any, spreadsheetId: string, sheetName: string): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: sheetName } } },
      ],
    },
  });

  // Add a header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:C1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["Title", "Pass/Fail", "Date"]],
    },
  });
}

/**
 * Modified Function: Check the last used column based on row 2 instead of row 1.
 *
 * Checks row 2 to determine the last used column, assuming row 1 contains headers.
 */
async function getLastUsedColumnIndex(sheets: any, spreadsheetId: string, sheetName: string) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!2:2`, // Changed from 1:1 to 2:2 to check row 2
  });
  const row = resp.data.values?.[0] || [];
  const usedCols = row.length;
  // If brand-new sheet with only headers, usedCols=0 => start at column 1
  return usedCols === 0 ? 1 : usedCols;
}

async function getExistingTitles(sheets: any, spreadsheetId: string, sheetName: string): Promise<string[]> {
  // Read A2:A to get existing test titles
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:A`,
  });
  const rows = resp.data.values || [];
  return rows.map((r: any) => r[0]);
}

/** Convert 1-based column index to A,B,...Z,AA,AB,... */
function colLetter(index: number): string {
  let temp = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    temp = String.fromCharCode(65 + remainder) + temp;
    index = Math.floor((index - 1) / 26);
  }
  return temp;
}

/** Apply data validation so that column acts as a checkbox.
 *  If we write "TRUE"/"FALSE" in the cell, it should appear checked/unchecked.
 */
async function addCheckboxColumn(
  sheets: any,
  spreadsheetId: string,
  sheetName: string,
  colIndex: number
) {
  const ss = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = ss.data.sheets?.find((s: any) => s.properties.title === sheetName);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1, // skip header row (0-based index)
              startColumnIndex: colIndex - 1, // zero-based
              endColumnIndex: colIndex,
            },
            cell: {
              dataValidation: {
                condition: { type: "BOOLEAN" },
                strict: true,
                showCustomUi: true,
              },
            },
            fields: "dataValidation",
          },
        },
      ],
    },
  });
}

/** Make "TRUE" cells green, "FALSE" cells red, in the newly used pass/fail column. */
async function addConditionalFormatting(
  sheets: any,
  spreadsheetId: string,
  sheetName: string,
  colIndex: number
) {
  const ss = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = ss.data.sheets?.find((s: any) => s.properties.title === sheetName);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId,
                  startRowIndex: 1, // skip header (0-based index)
                  startColumnIndex: colIndex - 1,
                  endColumnIndex: colIndex,
                },
              ],
              booleanRule: {
                condition: {
                  type: "TEXT_EQ",
                  values: [{ userEnteredValue: "TRUE" }],
                },
                format: { backgroundColor: { red: 0, green: 1, blue: 0 } },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId,
                  startRowIndex: 1,
                  startColumnIndex: colIndex - 1,
                  endColumnIndex: colIndex,
                },
              ],
              booleanRule: {
                condition: {
                  type: "TEXT_EQ",
                  values: [{ userEnteredValue: "FALSE" }],
                },
                format: { backgroundColor: { red: 1, green: 0, blue: 0 } },
              },
            },
            index: 1,
          },
        },
      ],
    },
  });
}

// Optionally run this:
(async (): Promise<void> => {
  const spreadsheetId = "1_7WKp4XRGWcLPhaBiCmnVfZwga2s3s5rzlFC4ssComU";
  try {
    await updateSpreadsheet(spreadsheetId);
  } catch (error) {
    console.error("Error updating spreadsheet:", error);
  }
})();

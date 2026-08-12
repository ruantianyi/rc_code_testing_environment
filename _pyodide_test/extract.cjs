// Extract the embedded fallback coreCode/utilsCode Python from app.js and write
// them to files so we can py_compile them.
const fs = require("fs");
const src = fs.readFileSync(
  "C:/Users/ruant/OneDrive/Documents/Racecar/ide/frontend/app.js", "utf8");

function extract(varname) {
  const startMarker = varname + " = `";
  const i = src.indexOf(startMarker);
  if (i < 0) { console.error("marker not found: " + varname); process.exit(2); }
  const start = i + startMarker.length;
  const end = src.indexOf("`;", start);
  if (end < 0) { console.error("end not found: " + varname); process.exit(2); }
  return src.slice(start, end);
}

fs.writeFileSync("C:/Users/ruant/OneDrive/Documents/Racecar/_pyodide_test/fallback_core.py", extract("coreCode"));
fs.writeFileSync("C:/Users/ruant/OneDrive/Documents/Racecar/_pyodide_test/fallback_utils.py", extract("utilsCode"));
console.log("extracted");

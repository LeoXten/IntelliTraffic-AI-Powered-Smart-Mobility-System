// server.js
const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.static(__dirname));
app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/routes", (req, res) => {
  const results = [];
  fs.createReadStream(path.join(__dirname, "signal.csv"))
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", () => res.json(results));
});

// Updated to save distance_time
app.post("/saveRouteSignals", (req, res) => {
  const routeData = req.body;

  if (!Array.isArray(routeData)) {
    return res.status(400).send("Invalid data format, expected an array");
  }

  let csvContent = "route,signal_count,signal_serial_numbers,distance_time\n";
  routeData.forEach(row => {
    csvContent += `"${row.route}","${row.signal_count}","${row.signal_serial_numbers}","${row.distance_time}"\n`;
  });

  const filePath = path.join(__dirname, "routeSignal.csv");

  fs.writeFile(filePath, csvContent, (err) => {
    if (err) {
      console.error("Error writing routeSignal.csv:", err);
      return res.status(500).send("Failed to save file");
    }
    console.log("routeSignal.csv saved successfully");
    res.send("File saved");
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`➡ Open http://localhost:${PORT}/ in your browser`);
});

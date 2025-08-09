// server.js
const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");
const path = require("path");
const { exec } = require("child_process");

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

// Save routeSignal.csv and run mainAlgo.py, then return the computed optimal route
app.post("/saveRouteSignals", (req, res) => {
  const routeData = req.body;

  if (!Array.isArray(routeData)) {
    return res.status(400).send("Invalid data format, expected an array");
  }

  let csvContent = "route,signal_count,signal_serial_numbers,distance_time\n";
  routeData.forEach(row => {
    // Ensure quotes to handle commas in fields
    csvContent += `"${row.route}","${row.signal_count}","${row.signal_serial_numbers}","${row.distance_time}"\n`;
  });

  const filePath = path.join(__dirname, "routeSignal.csv");

  fs.writeFile(filePath, csvContent, (err) => {
    if (err) {
      console.error("Error writing routeSignal.csv:", err);
      return res.status(500).send("Failed to save file");
    }
    console.log("routeSignal.csv saved successfully");

    // Run mainAlgo.py (assumes python3 is available). If you use Windows or only 'python', change to 'python'.
    // We run it and wait for it to create fastest_route.json in the same folder.
    // Use a timeout in case something hangs.
    const pythonCmd = "python mainAlgo.py";
    const proc = exec(pythonCmd, { cwd: __dirname, maxBuffer: 1024 * 1024 * 5 }, (execErr, stdout, stderr) => {
      if (execErr) {
        console.error("Error executing mainAlgo.py:", execErr);
        // Try fallback to 'python' if available (Windows)
        const fallback = exec("python mainAlgo.py", { cwd: __dirname, maxBuffer: 1024 * 1024 * 5 }, (e2, sOut, sErr) => {
          if (e2) {
            console.error("Fallback python execution also failed:", e2);
            return res.status(500).json({ success: false, error: "Failed to run processing script", details: String(e2) });
          }
          // On success read result file
          readFastestJson(res);
        });
        return;
      }

      // On success, read the result json file
      readFastestJson(res);
    });

    // safety: if the Python process doesn't write result file within N seconds, respond with an error
    function readFastestJson(response) {
      const resultFile = path.join(__dirname, "fastest_route.json");
      // wait briefly for file to appear
      const maxWaitMs = 10000; // 10s
      const pollInterval = 200;
      let waited = 0;

      const interval = setInterval(() => {
        if (fs.existsSync(resultFile)) {
          clearInterval(interval);
          try {
            const content = fs.readFileSync(resultFile, "utf-8");
            const json = JSON.parse(content);
            // Return the JSON result to frontend
            return response.json({ success: true, result: json });
          } catch (readErr) {
            console.error("Error reading or parsing fastest_route.json:", readErr);
            return response.status(500).json({ success: false, error: "Failed to parse fastest route file", details: String(readErr) });
          }
        } else {
          waited += pollInterval;
          if (waited >= maxWaitMs) {
            clearInterval(interval);
            console.error("Timeout waiting for fastest_route.json");
            return response.status(500).json({ success: false, error: "Processing timed out" });
          }
        }
      }, pollInterval);
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`➡ Open http://localhost:${PORT}/ in your browser`);
});

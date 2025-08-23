import asyncio
import csv
import json
import os
import subprocess
import websockets

SIGNAL_CSV = "signal.csv"
ALL_CROSSINGS_DIR = "All_Crossings"

clients = set()

async def read_csv():
    signals = []
    with open(SIGNAL_CSV, newline='', encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        for row in reader:
            crossing_name = f"Crossing_{row['SL_No']}"
            signals.append({
                "id": row["SL_No"],
                "name": row["Name"],
                "crossing": crossing_name
            })
    return signals

async def run_traffic(crossing_id, crossing_name):
    proc = await asyncio.create_subprocess_exec(
        "python", "traffic.py", crossing_name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async for line in proc.stdout:
        try:
            line = line.decode().strip()
            if not line:
                continue
            data = json.loads(line)
            update = {
                "type": "signal_update",
                "signal_id": crossing_id,
                "data": data
            }
            await broadcast(json.dumps(update))
        except json.JSONDecodeError:
            continue  # ignore malformed lines

async def broadcast(message):
    for ws in list(clients):
        try:
            await ws.send(message)
        except:
            clients.remove(ws)

async def ws_handler(websocket):
    clients.add(websocket)
    try:
        async for _ in websocket:
            pass
    finally:
        clients.remove(websocket)

async def main():
    signals = await read_csv()
    for s in signals:
        asyncio.create_task(run_traffic(s["id"], s["crossing"]))
    
    async with websockets.serve(ws_handler, "0.0.0.0", 8765):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
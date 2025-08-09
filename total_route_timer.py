import os
import csv
import re

# Constants
MAX_SIGNAL_TIME = 60
BUFFER_TIME = 5
MIN_GREEN_TIME = 5  # Minimum green signal required for fairness

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ALL_CROSSINGS_DIR = os.path.join(BASE_DIR, "All_Crossings")
ROUTE_SIGNAL_FILE = os.path.join(BASE_DIR, "routeSignal.csv")
SUMMARY_OUTPUT = os.path.join(BASE_DIR, "lane1_summary.csv")

# --- Helper functions ---
def read_lane_data(file_path):
    """Read lane_counts.csv and return {lane_name: signal_time}"""
    lane_data = {}
    with open(file_path, 'r') as file:
        reader = csv.DictReader(file)
        for row in reader:
            lane_name = row['Lane'].replace('.jpg', '').replace('.png', '')
            signal_time = int(row['Signal Time (s)'])
            lane_data[lane_name] = signal_time
    return lane_data

def calculate_lane1_time(lane_data):
    """Calculate total green time for Lane1 considering cycle rules"""
    lane1_time = lane_data.get("lane1", 0)
    lanes = sorted(lane_data.keys())
    other_lanes = {lane: lane_data[lane] for lane in lanes if lane != "lane1"}

    total_time = 0
    remaining_lane1 = lane1_time
    remaining_others = other_lanes.copy()

    while remaining_lane1 > MAX_SIGNAL_TIME:
        total_time += MAX_SIGNAL_TIME
        remaining_lane1 -= MAX_SIGNAL_TIME
        total_time += BUFFER_TIME

        for lane in remaining_others:
            time = min(remaining_others[lane], MAX_SIGNAL_TIME)
            if time <= 0:
                time = MIN_GREEN_TIME
            total_time += time + BUFFER_TIME
            remaining_others[lane] = max(0, remaining_others[lane] - time)

    if remaining_lane1 > 0:
        total_time += remaining_lane1

    return total_time

def parse_distance_time(distance_time_str):
    """Extract time in seconds from 'X km / Y min' format"""
    match = re.search(r'([\d\.]+)\s*min', distance_time_str)
    if match:
        return float(match.group(1)) * 60
    return 0

# --- Main processing ---
def process_routes():
    if not os.path.exists(ROUTE_SIGNAL_FILE):
        print(f"[Error] routeSignal.csv not found: {ROUTE_SIGNAL_FILE}")
        return

    # Read routeSignal.csv
    routes = []
    with open(ROUTE_SIGNAL_FILE, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            route_name = row['route'].strip('"')
            signals_str = row['signal_serial_numbers'].strip('"')
            signals = [s.strip() for s in signals_str.split(';') if s.strip()]
            distance_time_str = row['distance_time'].strip('"')
            distance_seconds = parse_distance_time(distance_time_str)
            routes.append({
                "name": route_name,
                "signals": signals,
                "distance_seconds": distance_seconds
            })

    summary_rows = []
    results = []

    for route in routes:
        route_total_time = 0
        route_details = []
        for signal_num in route["signals"]:
            crossing_folder = f"Crossing_{signal_num}"
            lane_counts_path = os.path.join(ALL_CROSSINGS_DIR, crossing_folder, "Output", "lane_counts.csv")
            if not os.path.exists(lane_counts_path):
                print(f"[Warning] lane_counts.csv not found for {crossing_folder}")
                continue

            lane_data = read_lane_data(lane_counts_path)
            lane1_time = calculate_lane1_time(lane_data)
            route_total_time += lane1_time
            summary_rows.append({
                "route": route["name"],
                "Crossing": crossing_folder,
                "Lane1 Total Time (s)": lane1_time
            })

        # Add travel time from distance_time
        route_total_time += route["distance_seconds"]

        results.append({
            "route": route["name"],
            "signals": route["signals"],
            "total_seconds": route_total_time
        })

    # Save CSV with route, crossing, lane1 time
    with open(SUMMARY_OUTPUT, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=["route", "Crossing", "Lane1 Total Time (s)"])
        writer.writeheader()
        writer.writerows(summary_rows)

    print(f"\n[✓] Summary saved to: {SUMMARY_OUTPUT}\n")

    # Print results
    for res in results:
        signal_list_str = ",".join(res["signals"])
        minutes = int(res["total_seconds"] // 60)
        seconds = int(res["total_seconds"] % 60)
        print(f"{res['route']}: signals: {signal_list_str} | Total Time: {minutes} min {seconds} sec")

    # Find fastest route
    if results:
        fastest = min(results, key=lambda x: x["total_seconds"])
        print(f"\n[FASTEST] {fastest['route']} with {','.join(fastest['signals'])} "
              f"({int(fastest['total_seconds']//60)} min {int(fastest['total_seconds']%60)} sec)")

if __name__ == "__main__":
    process_routes()

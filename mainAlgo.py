from ultralytics import YOLO
import cv2
import os
import pandas as pd
import csv
import re

# =========================
# Constants for YOLO processing
# =========================
MIN_SIGNAL_TIME = 5
TIME_PER_VEHICLE = 2.5

# =========================
# Constants for Route Timing
# =========================
MAX_SIGNAL_TIME = 60
BUFFER_TIME = 5
MIN_GREEN_TIME = 5  # Minimum green signal for fairness

# =========================
# Paths
# =========================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ALL_CROSSINGS_DIR = os.path.join(BASE_DIR, "All_Crossings")
ROUTE_SIGNAL_FILE = os.path.join(BASE_DIR, "routeSignal.csv")
SUMMARY_OUTPUT = os.path.join(BASE_DIR, "lane1_summary.csv")

# =========================
# YOLO model setup
# =========================
model = YOLO("yolov8m.pt")
vehicle_classes = ['car', 'truck', 'bus', 'motorbike', 'bicycle']


# =========================
# YOLO Helper Functions
# =========================
def count_vehicles(results):
    """Count only vehicles of interest from YOLO detections."""
    names = model.names
    count = 0
    for r in results:
        for cls in r.boxes.cls:
            label = names[int(cls)]
            if label in vehicle_classes:
                count += 1
    return count


def calculate_signal_time(vehicle_count):
    """Calculate green signal time based on vehicle count."""
    if vehicle_count == 0:
        return MIN_SIGNAL_TIME
    return max(MIN_SIGNAL_TIME, int(vehicle_count * TIME_PER_VEHICLE))


def process_crossing(crossing_path):
    """Process all lane images inside a crossing folder."""
    lanes_path = os.path.join(crossing_path, "Lanes")
    output_path = os.path.join(crossing_path, "Output")
    os.makedirs(output_path, exist_ok=True)

    data = []

    for lane_img in sorted(os.listdir(lanes_path)):
        if lane_img.lower().endswith(('.png', '.jpg', '.jpeg')):
            image_path = os.path.join(lanes_path, lane_img)
            image = cv2.imread(image_path)
            results = model(image, conf=0.35)
            count = count_vehicles(results)
            signal_time = calculate_signal_time(count)

            # Save annotated image
            annotated_image = results[0].plot()
            cv2.imwrite(os.path.join(output_path, f"annotated_{lane_img}"), annotated_image)

            data.append({
                "Lane": lane_img,
                "Vehicle Count": count,
                "Signal Time (s)": signal_time
            })

            print(f"[{crossing_path}] {lane_img}: {count} vehicles => Signal Time: {signal_time}s")

    # Save CSV for this crossing
    df = pd.DataFrame(data)
    output_csv_path = os.path.join(output_path, "lane_counts.csv")
    df.to_csv(output_csv_path, index=False)
    print(f"✅ Saved: {output_csv_path}")


def get_crossings_from_route_signal(csv_path):
    """Reads routeSignal.csv and returns a unique list of crossing folder names to process."""
    try:
        with open(csv_path, newline='', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            rows = list(reader)
    except Exception as e:
        print(f"❌ Error reading {csv_path}: {e}")
        return []
    
    if not rows:
        print("⚠ routeSignal.csv is empty!")
        return []

    all_signals = set()

    for row in rows:
        signal_numbers_str = row.get("signal_serial_numbers", "").strip()
        if signal_numbers_str:
            for num in signal_numbers_str.split(";"):
                num = num.strip()
                if num:
                    all_signals.add(f"Crossing_{num}")

    return sorted(all_signals)


# =========================
# Route Timer Helper Functions
# =========================
def read_lane_data(file_path):
    """Read lane_counts.csv and return {lane_name: signal_time}"""
    lane_data = {}
    with open(file_path, 'r') as file:
        reader = csv.DictReader(file)
        for row in reader:
            lane_name = row['Lane'].replace('.jpg', '').replace('.png', '').lower()
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


# =========================
# Main Combined Process
# =========================
def main():
    # Step 1: Process lanes for crossings in routeSignal.csv
    crossings_to_process = get_crossings_from_route_signal(ROUTE_SIGNAL_FILE)
    if not crossings_to_process:
        print("⚠ No crossings to process. Exiting.")
        return

    print(f"📌 Processing crossings: {', '.join(crossings_to_process)}")
    for crossing_folder in sorted(os.listdir(ALL_CROSSINGS_DIR)):
        if crossing_folder in crossings_to_process:
            crossing_path = os.path.join(ALL_CROSSINGS_DIR, crossing_folder)
            if os.path.isdir(crossing_path) and "Lanes" in os.listdir(crossing_path):
                process_crossing(crossing_path)

    # Step 2: Calculate total route times
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

    # Filter out invalid routes (no signals AND total time = 0)
    valid_results = [r for r in results if not (len(r["signals"]) == 0 and r["total_seconds"] == 0)]

    # Find fastest route
    if valid_results:
        fastest = min(valid_results, key=lambda x: x["total_seconds"])
        print(f"\n[FASTEST] {fastest['route']} with {','.join(fastest['signals'])} "
              f"({int(fastest['total_seconds']//60)} min {int(fastest['total_seconds']%60)} sec)")
    else:
        print("\n⚠ No valid routes to compare.")


if __name__ == "__main__":
    main()

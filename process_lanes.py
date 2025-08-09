from ultralytics import YOLO
import cv2
import os
import pandas as pd
import csv

# =========================
# Constants
# =========================
MIN_SIGNAL_TIME = 5
TIME_PER_VEHICLE = 2.5

# Load YOLOv8 model
model = YOLO("yolov8m.pt")

# Vehicle types to detect
vehicle_classes = ['car', 'truck', 'bus', 'motorbike', 'bicycle']


# =========================
# Functions
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

    all_signals = set()  # use a set to avoid duplicates

    for row in rows:
        signal_numbers_str = row.get("signal_serial_numbers", "").strip()
        if signal_numbers_str:
            for num in signal_numbers_str.split(";"):
                num = num.strip()
                if num:
                    all_signals.add(f"Crossing_{num}")

    return sorted(all_signals)


def process_route(route_path="All_Crossings", route_signal_csv="routeSignal.csv"):
    """Processes only crossings listed in all rows of routeSignal.csv."""
    crossings_to_process = get_crossings_from_route_signal(route_signal_csv)
    if not crossings_to_process:
        print("⚠ No crossings to process. Exiting.")
        return

    print(f"📌 Processing crossings: {', '.join(crossings_to_process)}")

    for crossing_folder in sorted(os.listdir(route_path)):
        if crossing_folder in crossings_to_process:
            crossing_path = os.path.join(route_path, crossing_folder)
            if os.path.isdir(crossing_path) and "Lanes" in os.listdir(crossing_path):
                process_crossing(crossing_path)


# =========================
# Main Execution
# =========================
if __name__ == "__main__":
    process_route("All_Crossings", "routeSignal.csv")

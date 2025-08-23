import os
import sys
import time
import json
from datetime import datetime

SECONDS_PER_VEHICLE = 2.5
MIN_GREEN_TIME = 5
MAX_GREEN_TIME = 60
YELLOW_BUFFER = 5

VEHICLE_CLASSES = {
    "car", "truck", "bus", "motorcycle", "motorbike", "bicycle", "van", "auto", "autorickshaw"
}

MODEL_CANDIDATES = ["yolov8n.pt", "yolov8m.pt", "yolov8s.pt"]

def pick_model_path():
    for m in MODEL_CANDIDATES:
        if os.path.exists(m):
            return m
    raise FileNotFoundError("No YOLO model found.")

def resolve_lanes_dir():
    if len(sys.argv) < 2:
        raise ValueError("Crossing name/number required.")
    crossing_name = sys.argv[1]
    lanes_path = os.path.join("All_Crossings", crossing_name, "Lanes")
    if not os.path.isdir(lanes_path):
        raise FileNotFoundError(f"No lanes folder: {lanes_path}")
    return lanes_path

def _find_lane_image(lanes_dir, lane_number):
    exts = ("jpg", "jpeg", "png", "bmp", "webp")
    for ext in exts:
        p = os.path.join(lanes_dir, f"lane{lane_number}.{ext}")
        if os.path.exists(p):
            return p
    return None

def discover_lanes(lanes_dir):
    lanes = []
    for i in range(1, 5):
        img = _find_lane_image(lanes_dir, i)
        if img:
            lanes.append((f"Lane {i}", img))
    return lanes

def load_model():
    model_path = pick_model_path()
    from ultralytics import YOLO
    return YOLO(model_path)

def count_vehicles(model, image_path):
    results = model(image_path, verbose=False)
    count = 0
    for r in results:
        names = getattr(r, "names", None) or getattr(model, "names", {})
        if r.boxes is None or r.boxes.cls is None:
            continue
        for c in r.boxes.cls.tolist():
            cls_name = names.get(int(c), str(int(c)))
            if cls_name in VEHICLE_CLASSES:
                count += 1
    return count

def green_time_from_count(n):
    t = int(n * SECONDS_PER_VEHICLE)
    return max(MIN_GREEN_TIME, min(t, MAX_GREEN_TIME))

def run_traffic_controller():
    lanes_dir = resolve_lanes_dir()
    lanes = discover_lanes(lanes_dir)
    if len(lanes) < 2:
        raise RuntimeError("Need at least 2 lanes.")

    model = load_model()
    current_idx = 0
    pre_scanned = None

    while True:
        lane_name, lane_img = lanes[current_idx]

        if pre_scanned and pre_scanned.get("idx") == current_idx:
            vehicle_count = pre_scanned.get("count", 0)
            pre_scanned = None
        else:
            vehicle_count = count_vehicles(model, lane_img)

        green_time = green_time_from_count(vehicle_count)
        timestamp = datetime.now().isoformat()

        # Send GREEN state update
        print(json.dumps({
            "state": "GREEN",
            "current_lane": lane_name,
            "vehicle_count": vehicle_count,
            "green_time": green_time,
            "remaining_time": green_time,
            "timestamp": timestamp
        }), flush=True)

        time.sleep(green_time)

        next_idx = (current_idx + 1) % len(lanes)
        next_lane_name, next_lane_img = lanes[next_idx]
        next_count = count_vehicles(model, next_lane_img)
        pre_scanned = {"idx": next_idx, "count": next_count}

        # Send YELLOW state update
        print(json.dumps({
            "state": "YELLOW",
            "current_lane": lane_name,
            "next_lane": next_lane_name,
            "vehicle_count": vehicle_count,
            "yellow_time": YELLOW_BUFFER,
            "timestamp": datetime.now().isoformat()
        }), flush=True)

        time.sleep(YELLOW_BUFFER)
        current_idx = next_idx

if __name__ == "__main__":
    run_traffic_controller()
import sys
import json
import os
import math
import cv2
import numpy as np
from ultralytics import YOLO

MODEL_PATH = os.getenv("YOLO_MODEL", "yolov8n.pt")
CLOSE_VEHICLE_COUNT_THRESHOLD = 2
CLOSE_DISTANCE_PIXELS = 80

def center(box):
    x1, y1, x2, y2 = box
    return ((x1+x2)/2, (y1+y2)/2)

def euclidean(a, b):
    return math.hypot(a[0]-b[0], a[1]-b[1])

def check_accident_by_model_results(results):
    for r in results:
        if hasattr(r.boxes, "cls_names"):
            for cls_name in r.boxes.cls_names:
                if cls_name.lower() == "accident":
                    return True, {"reason": "model_accident_class"}

    vehicles = []
    for r in results:
        boxes = r.boxes.xyxy.cpu().numpy() if hasattr(r.boxes, "xyxy") else np.array([])
        classes = r.boxes.cls.cpu().numpy() if hasattr(r.boxes, "cls") else np.array([])
        for i, b in enumerate(boxes):
            if int(classes[i]) in [2, 5, 7]:
                vehicles.append(b.tolist())

    centers = [center(b) for b in vehicles]
    close_pairs = sum(
        1 for i in range(len(centers)) for j in range(i+1, len(centers))
        if euclidean(centers[i], centers[j]) < CLOSE_DISTANCE_PIXELS
    )

    if len(vehicles) >= CLOSE_VEHICLE_COUNT_THRESHOLD and close_pairs >= 1:
        return True, {
            "reason": "vehicle_proximity",
            "vehicle_count": len(vehicles),
            "close_pairs": close_pairs
        }

    return False, {"reason": "no_accident_detected", "vehicle_count": len(vehicles)}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No image path provided"}))
        sys.exit(1)

    img_path = sys.argv[1]
    if not os.path.exists(img_path):
        print(json.dumps({"error": "Image not found", "path": img_path}))
        sys.exit(1)

    try:
        img = cv2.imread(img_path)
        if img is None:
            raise ValueError("cv2.imread() failed — invalid image file.")
    except Exception as e:
        print(json.dumps({"error": "Image read failed", "exception": str(e)}))
        sys.exit(1)

    try:
        model = YOLO(MODEL_PATH)
    except Exception as e:
        print(json.dumps({"error": "Model load failed", "exception": str(e)}))
        sys.exit(1)

    try:
        results = model(img, imgsz=640, verbose=False)  # suppress logs
    except Exception as e:
        print(json.dumps({"error": "Inference failed", "exception": str(e)}))
        sys.exit(1)

    accident_detected, info = check_accident_by_model_results(results)

    # Ensure ONLY JSON is printed
    sys.stdout.write(json.dumps({"accident": accident_detected, "info": info}))
    sys.stdout.flush()

if __name__ == "__main__":
    main()
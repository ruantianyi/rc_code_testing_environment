# Minimal fallback: if fetch of racecar_utils.py failed (file://), this stub
# provides the most commonly used helpers with the correct signatures.
# Full implementation lives in racecar_utils.py on disk.
# If you see this message, run: python server.py and open http://127.0.0.1:8000
print("[WARN] racecar_utils.py full library not loaded, using minimal shim")
print("[WARN] Run python server.py instead of opening file:// for full functionality")

import numpy as np
import cv2

def clamp(value, min, max):
    return min if value < min else max if value > max else value

def remap_range(value, old_min, old_max, new_min, new_max, saturate=False):
    new_val = new_min + (new_max - new_min) * (float(value - old_min) / float(old_max - old_min))
    if saturate:
        if new_min < new_max:
            return clamp(new_val, new_min, new_max)
        return clamp(new_val, new_max, new_min)
    return new_val

def crop(image, top_left, bottom_right):
    return image[top_left[0]:bottom_right[0], top_left[1]:bottom_right[1]]

def stack_images_horizontal(image_0, image_1):
    return np.hstack((image_0, image_1))

def stack_images_vertical(image_0, image_1):
    return np.vstack((image_0, image_1))

def find_contours(color_image, hsv_lower, hsv_upper):
    hsv = cv2.cvtColor(color_image, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, hsv_lower, hsv_upper)
    return cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]

def get_largest_contour(contours, min_area=30):
    if len(contours) == 0: return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < min_area: return None
    return largest

def get_contour_center(contour):
    M = cv2.moments(contour)
    if M["m00"] <= 0: return None
    return (round(M["m01"] / M["m00"]), round(M["m10"] / M["m00"]))

def get_contour_area(contour):
    return cv2.contourArea(contour)

def draw_contour(color_image, contour, color=(0, 255, 0)):
    cv2.drawContours(color_image, [contour], 0, color, 3)

def draw_circle(color_image, center, color=(0, 255, 255), radius=6):
    cv2.circle(color_image, (center[1], center[0]), radius, color, -1)

def get_depth_image_center_distance(depth_image, kernel_size=5):
    h, w = depth_image.shape
    return float(depth_image[h // 2, w // 2])

def get_closest_pixel(depth_image, kernel_size=5):
    idx = int(np.argmin(depth_image))
    return (idx // depth_image.shape[1], idx % depth_image.shape[1])

def colormap_depth_image(depth_image, max_depth=1000):
    np.clip(depth_image, None, max_depth, depth_image)
    depth_image = (depth_image - 0.01) % max_depth
    return cv2.applyColorMap(-cv2.convertScaleAbs(depth_image, alpha=255 / max_depth), cv2.COLORMAP_INFERNO)

def get_lidar_closest_point(scan, window=(0, 360)):
    if len(scan) == 0: return (0.0, 0.0)
    valid = np.where(scan > 0, scan, np.inf)
    idx = int(np.argmin(valid))
    return (idx * 360.0 / len(scan), float(valid[idx]))

def get_lidar_average_distance(scan, angle, window_angle=4):
    if len(scan) == 0: return 0.0
    angle %= 360
    center = int(angle * len(scan) / 360)
    n = max(1, int(window_angle / 2 * len(scan) / 360))
    vals = [float(scan[(center + i) % len(scan)]) for i in range(-n, n + 1) if scan[(center + i) % len(scan)] > 0]
    if not vals: return 0.0
    return sum(vals) / len(vals)

def pixelate_image(img, size=(24, 8)):
    w, h = size
    return cv2.resize(img, (w, h), interpolation=cv2.INTER_LINEAR)

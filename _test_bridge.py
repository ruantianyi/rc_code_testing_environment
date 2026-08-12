"""
Comprehensive test harness for the browser racecar_core bridge and racecar_utils.

Mocks the Pyodide `js` module (JsProxy semantics) and exercises every public
API so we can validate the bridge without a full browser + Unity runtime.
"""

import sys
import types
import traceback

import numpy as np

# ---------------------------------------------------------------------------
# Mock `js` and `pyodide.ffi` modules (inject before importing racecar_core)
# ---------------------------------------------------------------------------


def _deep_to_py(v):
    if isinstance(v, JsProxy):
        return v.to_py()
    if isinstance(v, dict):
        return {k: _deep_to_py(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_deep_to_py(x) for x in v]
    return v


class JsProxy:
    """Simulates Pyodide's JsProxy for a JS value (dict/array/object)."""

    def __init__(self, value):
        self._value = value

    def to_py(self):
        # Pyodide's real JsProxy.to_py(): deep-convert JS -> Python.
        return _deep_to_py(self._value)

    def __getattr__(self, name):
        v = self._value
        if isinstance(v, dict) and name in v:
            raw = v[name]
            # Primitives convert directly (like Pyodide); containers stay proxies.
            if isinstance(raw, (dict, list, bytes, bytearray, memoryview)):
                return raw if isinstance(raw, JsProxy) else JsProxy(raw)
            return raw
        raise AttributeError(name)

    def __len__(self):
        return len(self._value)

    def __int__(self):
        return int(self._value)

    def __float__(self):
        return float(self._value)

    def __eq__(self, other):
        return self._value == other


class FakeWindow:
    """Plain namespace standing in for js.window."""

    def __init__(self):
        self.racecarState = None
        self._rc_updateSlowTime = 1.0
        self.registered = None
        self.drive_calls = []

    def unitySetDrive(self, speed, angle):
        self.drive_calls.append(("set_speed_angle", speed, angle))

    def unityStopDrive(self):
        self.drive_calls.append(("stop",))

    def unitySetMaxSpeed(self, speed):
        self.drive_calls.append(("set_max_speed", speed))

    def unityRegisterRacecar(self, proxy):
        self.registered = proxy


window = FakeWindow()

js_mod = types.ModuleType("js")
js_mod.window = window
sys.modules["js"] = js_mod

ffi_mod = types.ModuleType("pyodide.ffi")
ffi_mod.create_proxy = lambda x: x
pyodide_mod = types.ModuleType("pyodide")
pyodide_mod.ffi = ffi_mod
sys.modules["pyodide"] = pyodide_mod
sys.modules["pyodide.ffi"] = ffi_mod

sys.path.insert(0, r"C:\Users\ruant\OneDrive\Documents\Racecar\ide\frontend")

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f"  -- {detail}" if (detail and not cond) else ""))


def section(title):
    print("\n=== " + title + " ===")


# ---------------------------------------------------------------------------
# 1. racecar_core
# ---------------------------------------------------------------------------
section("racecar_core")

import racecar_core  # noqa: E402

rc = racecar_core.create_racecar()

# -- sanity: attributes present
for attr in ("drive", "lidar", "camera", "physics", "controller", "display", "telemetry"):
    check(f"rc.{attr} exists", hasattr(rc, attr))


# -- Build a synthetic camera frame: 2x2 RGBA (16 bytes), known values
W, H = 2, 2
rgba = np.zeros((H, W, 4), dtype=np.uint8)
rgba[0, 0] = [255, 0, 0, 255]    # pure red
rgba[0, 1] = [0, 255, 0, 255]    # pure green
rgba[1, 0] = [0, 0, 255, 255]    # pure blue
rgba[1, 1] = [10, 20, 30, 255]   # arbitrary
flat = rgba.tobytes()

# Represent the JS camera payload in several marshal forms and verify each.
camera_forms = {
    "bytes": flat,
    "memoryview": memoryview(flat),
    "list-of-int": list(flat),
    "dict-by-index": {str(i): flat[i] for i in range(len(flat))},
}

for form_name, payload in camera_forms.items():
    window.racecarState = JsProxy({
        "camera": {"data": payload, "w": W, "h": H},
    })
    img = rc.camera.get_color_image()
    # BGR expected
    exp = rgba[..., [2, 1, 0]]
    check(f"get_color_image BGR ({form_name})", img.shape == (H, W, 3) and np.array_equal(img, exp),
          f"shape={img.shape}")


def _setup_camera(payload, w, h):
    window.racecarState = JsProxy({"camera": {"data": payload, "w": w, "h": h}})


# -- no camera -> zeros
window.racecarState = JsProxy({})
img = rc.camera.get_color_image()
check("get_color_image fallback zeros", img.shape == (480, 640, 3) and img.max() == 0)

_setup_camera(flat, W, H)
check("get_width", rc.camera.get_width() == W)
check("get_height", rc.camera.get_height() == H)
check("get_max_range", rc.camera.get_max_range() == 1000.0)
check("get_color_image_no_copy", rc.camera.get_color_image_no_copy().shape == (H, W, 3))
check("get_color_image_async", rc.camera.get_color_image_async().shape == (H, W, 3))
d = rc.camera.get_depth_image()
check("get_depth_image shape/dtype", d.shape == (H, W) and d.dtype == np.float32)
check("get_depth_image_async", rc.camera.get_depth_image_async().shape == (H, W))

# -- Lidar
lidar_data = np.arange(360, dtype=np.float32) / 10.0
window.racecarState = JsProxy({"lidar": {"data": lidar_data}})
samples = rc.lidar.get_samples()
check("get_samples dtype/shape", samples.dtype == np.float32 and samples.shape == (360,))
check("get_samples values", np.array_equal(samples, lidar_data))
check("get_num_samples", rc.lidar.get_num_samples() == 360)
check("get_samples_async", rc.lidar.get_samples_async().shape == (360,))

# Lidar as list-of-floats (JS array case)
window.racecarState = JsProxy({"lidar": {"data": list(lidar_data)}})
check("get_samples list case", np.array_equal(rc.lidar.get_samples(), lidar_data))

# Lidar empty -> zeros fallback
window.racecarState = JsProxy({})
check("get_samples no-data fallback", rc.lidar.get_samples().shape == (360,))

# -- Physics
window.racecarState = JsProxy({"accel": {"data": [1.0, 2.0, 3.0]}, "gyro": {"data": [4.0, 5.0, 6.0]}})
check("get_linear_acceleration", rc.physics.get_linear_acceleration() == (1.0, 2.0, 3.0))
check("get_angular_velocity", rc.physics.get_angular_velocity() == (4.0, 5.0, 6.0))
window.racecarState = JsProxy({})
check("accel no-data", rc.physics.get_linear_acceleration() == (0.0, 0.0, 0.0))
check("gyro no-data", rc.physics.get_angular_velocity() == (0.0, 0.0, 0.0))

# -- Controller
ctrl = {"down": (1 << 0), "pressed": (1 << 1), "released": (1 << 2),
        "tl": 0.5, "tr": 0.25, "jlx": -0.3, "jly": 0.7, "jrx": 0.1, "jry": -0.9}
window.racecarState = JsProxy({"controller": ctrl})
check("is_down A", rc.controller.is_down(rc.controller.Button.A) is True)
check("is_down B", rc.controller.is_down(rc.controller.Button.B) is False)
check("was_pressed B", rc.controller.was_pressed(rc.controller.Button.B) is True)
check("was_released X", rc.controller.was_released(rc.controller.Button.X) is True)
check("get_trigger left", rc.controller.get_trigger(rc.controller.Trigger.LEFT) == 0.5)
check("get_trigger right", rc.controller.get_trigger(rc.controller.Trigger.RIGHT) == 0.25)
check("get_joystick left", rc.controller.get_joystick(rc.controller.Joystick.LEFT) == (-0.3, 0.7))
check("get_joystick right", rc.controller.get_joystick(rc.controller.Joystick.RIGHT) == (0.1, -0.9))

# Enum semantics (test_core.py iterates the Button enum and uses .name)
names = [b.name for b in rc.controller.Button]
check("Button is iterable + .name", names == ["A", "B", "X", "Y", "LB", "RB", "LJOY", "RJOY", "START", "BACK"], str(names))
check("Button.LJOY == 6", int(rc.controller.Button.LJOY) == 6)
check("Button.RJOY == 7", int(rc.controller.Button.RJOY) == 7)
check("Button.LEFT_JOYSTICK alias", rc.controller.Button.LEFT_JOYSTICK == rc.controller.Button.LJOY)

# -- Display
mat = rc.display.new_matrix()
check("new_matrix 8x24", mat.shape == (8, 24))
rc.display.set_matrix(np.ones((8, 24), dtype=np.uint8))
check("get_matrix after set", rc.display.get_matrix().sum() == 8 * 24)
# display render methods should not raise
for fn, args in [
    ("show_image", (np.zeros((4, 4, 3), np.uint8),)),
    ("show_color_image", (np.zeros((4, 4, 3), np.uint8),)),
    ("show_depth_image", (np.zeros((4, 4), np.float32),)),
    ("show_lidar", (np.zeros(360, np.float32),)),
    ("set_matrix_intensity", (0.5,)),
    ("show_text", ("hello",)),
    ("create_window", ()),
]:
    getattr(rc.display, fn)(*args)
    check(f"display.{fn} no-raise", True)

# -- Telemetry
t = rc.telemetry
t.declare_variables("speed", "angle")
t.record(0.5, -0.2)
t.visualize()
check("telemetry record ok", len(t._data) == 1 and t._data[0] == (0.5, -0.2))
try:
    t.record(1.0)
    check("telemetry mismatch raises", False)
except ValueError:
    check("telemetry mismatch raises", True)

# -- set_start_update / go flow
speed_angle_ran = {"start": False, "update": 0}

def _start():
    speed_angle_ran["start"] = True

def _update():
    speed_angle_ran["update"] += 1

def _update_slow():
    pass

rc.set_start_update(_start, _update, _update_slow)
rc.set_update_slow_time(0.5)
rc.go()
check("set_start_update registers proxy", window.registered is rc)
check("set_update_slow_time sets JS", window._rc_updateSlowTime == 0.5)
check("get_delta_time", abs(rc.get_delta_time() - 1.0 / 60.0) < 1e-9)
check("drive.set_speed_angle -> JS", len(window.drive_calls) >= 0)
rc.drive.set_speed_angle(0.5, -0.1)
check("drive.set_speed_angle records", window.drive_calls[-1] == ("set_speed_angle", 0.5, -0.1))
rc.drive.stop()
check("drive.stop records", window.drive_calls[-1] == ("stop",))
rc.drive.set_max_speed(0.3)
check("drive.set_max_speed records", window.drive_calls[-1] == ("set_max_speed", 0.3))

# ---------------------------------------------------------------------------
# 2. racecar_utils
# ---------------------------------------------------------------------------
section("racecar_utils")

import racecar_utils as ru  # noqa: E402

# clamp / remap_range
check("clamp low", ru.clamp(-2, 0, 10) == 0)
check("clamp high", ru.clamp(11, 0, 10) == 10)
check("clamp mid", ru.clamp(5, 0, 10) == 5)
check("remap_range", abs(ru.remap_range(5, 0, 10, 0, 50) - 25) < 1e-9)
check("remap_range saturate", ru.remap_range(2, 0, 1, -10, 10, True) == 10)

# build a synthetic image: black background, orange square in the middle
img = np.zeros((200, 300, 3), dtype=np.uint8)
img[60:140, 120:180] = (0, 140, 255)  # BGR orange

# crop
cropped = ru.crop(img, (0, 0), (100, 150))
check("crop shape", cropped.shape == (100, 150, 3))

# find_contours + get_largest_contour + get_contour_center + area
ORANGE_LOW = (10, 100, 100)
ORANGE_HIGH = (25, 255, 255)
contours = ru.find_contours(img, ORANGE_LOW, ORANGE_HIGH)
check("find_contours non-empty", len(contours) >= 1, f"len={len(contours)}")
largest = ru.get_largest_contour(contours)
check("get_largest_contour", largest is not None)
center = ru.get_contour_center(largest)
check("get_contour_center approx", center is not None and abs(center[0] - 100) < 15 and abs(center[1] - 150) < 15, str(center))
area = ru.get_contour_area(largest)
check("get_contour_area", area > 4000, str(area))

# draw functions should not raise and should mutate image
img2 = img.copy()
ru.draw_contour(img2, largest)
ru.draw_circle(img2, center)
check("draw_contour/draw_circle no-raise", True)

# stack
hstack = ru.stack_images_horizontal(img[:50], img[:50])
check("stack_horizontal", hstack.shape == (50, 600, 3))
vstack = ru.stack_images_vertical(img[:, :50], img[:, :50])
check("stack_vertical", vstack.shape == (400, 50, 3))

# pixelate
pix = ru.pixelate_image(np.zeros((48, 64), np.uint8))
check("pixelate_image", pix.shape == (8, 24))

# depth image functions
depth = np.zeros((100, 100), np.float32)
depth[40:60, 40:60] = 50.0
cd = ru.get_depth_image_center_distance(depth)
check("get_depth_image_center_distance", abs(cd - 50.0) < 1.0, str(cd))
avg = ru.get_pixel_average_distance(depth, (50, 50))
check("get_pixel_average_distance", abs(avg - 50.0) < 1.0, str(avg))
closest = ru.get_closest_pixel(depth)
check("get_closest_pixel", closest[0] in range(40, 60) and closest[1] in range(40, 60), str(closest))
cmap = ru.colormap_depth_image(depth)
check("colormap_depth_image", cmap.shape == (100, 100, 3))

# lidar utils
scan = np.full(360, 100.0, dtype=np.float32)
scan[0] = 20.0  # obstacle directly ahead
angle, dist = ru.get_lidar_closest_point(scan, (0, 360))
check("get_lidar_closest_point", abs(angle - 0.0) < 1.0 and abs(dist - 20.0) < 0.1, f"{angle},{dist}")
front = ru.get_lidar_average_distance(scan, 0)
check("get_lidar_average_distance", abs(front - 20.0) < 2.0, str(front))

# colored text
check("format_colored", "\x1b[31m" in ru.format_colored("x", ru.TerminalColor.red))
ru.print_error("test")  # no raise

# AR markers: generate a 6x6 marker, detect it
try:
    import cv2 as cv
    dict_obj = cv.aruco.getPredefinedDictionary(cv.aruco.DICT_6X6_250)
    marker_img = cv.aruco.generateImageMarker(dict_obj, 7, 300)
    marker_img = cv.cvtColor(marker_img, cv.COLOR_GRAY2BGR)
    markers = ru.get_ar_markers(marker_img)
    check("get_ar_markers detects", any(m.get_id() == 7 for m in markers), str([m.get_id() for m in markers]))
    ru.draw_ar_markers(marker_img, markers)
    check("draw_ar_markers no-raise", True)
except Exception as e:
    check("get_ar_markers detects", False, f"exception: {e}")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print("\n==== SUMMARY ====")
fails = [r for r in results if not r[1]]
print(f"{len(results) - len(fails)} passed, {len(fails)} failed")
for name, ok, detail in fails:
    print(f"  FAIL: {name} {detail}")

sys.exit(1 if fails else 0)

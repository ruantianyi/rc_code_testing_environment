import js  # type: ignore
import numpy as np  # type: ignore
from pyodide.ffi import create_proxy  # type: ignore

class Drive:
    def set_speed_angle(self, speed, angle):
        js.window.unitySetDrive(speed, angle)
    def stop(self):
        js.window.unityStopDrive()
    def set_max_speed(self, max_speed):
        js.window.unitySetMaxSpeed(max_speed)

class Lidar:
    def get_samples(self):
        if not hasattr(js.window, "racecarState") or not hasattr(js.window.racecarState, "lidar"):
            return np.zeros(360, dtype=np.float32)
        return np.asarray(js.window.racecarState.lidar.to_py(), dtype=np.float32)
    def get_num_samples(self):
        return 360

class Camera:
    def get_color_image(self):
        if not hasattr(js.window, "racecarState") or not hasattr(js.window.racecarState, "camera"):
            return np.zeros((480, 640, 3), dtype=np.uint8)
        cam = js.window.racecarState.camera
        raw = cam.to_py()
        # Unity may marshal camera bytes as a plain JS object (dict keyed by
        # integer index) instead of a Uint8Array depending on its WebGL bridge
        # version. np.asarray() chokes on dict, so flatten to a list first.
        if isinstance(raw, dict):
            raw = list(raw.values())
        arr = np.asarray(raw, dtype=np.uint8)
        arr = arr.reshape((cam.h, cam.w, 4))
        # Convert RGBA to BGR for OpenCV
        bgr = np.empty((cam.h, cam.w, 3), dtype=np.uint8)
        bgr[..., 0] = arr[..., 2] # B
        bgr[..., 1] = arr[..., 1] # G
        bgr[..., 2] = arr[..., 0] # R
        return bgr
    def get_width(self):
        return 640
    def get_height(self):
        return 480

class Physics:
    def get_linear_acceleration(self):
        if not hasattr(js.window, "racecarState"): return (0.0, 0.0, 0.0)
        if not hasattr(js.window.racecarState, "accel"): return (0.0, 0.0, 0.0)
        try:
            return tuple(js.window.racecarState.accel.to_py())
        except Exception:
            return (0.0, 0.0, 0.0)
    def get_angular_velocity(self):
        if not hasattr(js.window, "racecarState"): return (0.0, 0.0, 0.0)
        if not hasattr(js.window.racecarState, "gyro"): return (0.0, 0.0, 0.0)
        try:
            return tuple(js.window.racecarState.gyro.to_py())
        except Exception:
            return (0.0, 0.0, 0.0)

class Controller:
    # Inner classes mirror the real RACECAR-MN controller enums exactly
    class Button:
        A = 0
        B = 1
        X = 2
        Y = 3
        LB = 4
        RB = 5
        LEFT_JOYSTICK = 6
        RIGHT_JOYSTICK = 7
        START = 8
        BACK = 9

    class Trigger:
        LEFT = 0
        RIGHT = 1

    class Joystick:
        LEFT = 0
        RIGHT = 1

    def _ctrl(self):
        if not hasattr(js.window, "racecarState"): return None
        c = js.window.racecarState
        return c.controller if hasattr(c, "controller") else None

    def is_down(self, button):
        c = self._ctrl()
        return bool(c and (c.down & (1 << int(button))))
    def was_pressed(self, button):
        c = self._ctrl()
        return bool(c and (c.pressed & (1 << int(button))))
    def was_released(self, button):
        c = self._ctrl()
        return bool(c and (c.released & (1 << int(button))))
    def get_trigger(self, trigger):
        c = self._ctrl()
        if not c: return 0.0
        return c.tl if int(trigger) == 0 else c.tr
    def get_joystick(self, joystick):
        c = self._ctrl()
        if not c: return (0.0, 0.0)
        return (c.jlx, c.jly) if int(joystick) == 0 else (c.jrx, c.jry)

class Display:
    def show_image(self, image):
        pass
    def show_color_image(self, image):
        pass  # browser display handled separately


class Racecar:
    def __init__(self):
        self.drive = Drive()
        self.lidar = Lidar()
        self.camera = Camera()
        self.physics = Physics()
        self.controller = Controller()
        self.display = Display()
        self._update_slow_time = 1.0

    def set_start_update(self, start_func, update_func, update_slow_func=None):
        self._start_func = start_func
        self._update_func = update_func
        self._update_slow_func = update_slow_func
        # Create a persistent proxy so JS can hold a reference to this Python
        # object across async frames without Pyodide auto-destroying it.
        self._proxy = create_proxy(self)
        js.window.unityRegisterRacecar(self._proxy)

    def set_update_slow_time(self, time):
        self._update_slow_time = float(time)
        js.window._rc_updateSlowTime = self._update_slow_time

    def get_delta_time(self):
        return 1.0 / 60.0

    def go(self):
        pass

def create_racecar():
    return Racecar()

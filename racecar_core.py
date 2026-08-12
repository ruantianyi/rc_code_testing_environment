"""
MIT BWSI Autonomous RACECAR — racecar_core bridge for the browser (Pyodide) IDE.

This module re-implements the public ``racecar_core`` API so that student lab
scripts written for the physical RACECAR Neo run unchanged in the browser.

Unlike the physical library (which talks to hardware over sockets), this bridge
reads sensor data that Unity pushes into ``window.racecarState`` via app.js, and
writes drive commands back to Unity through ``js.window.unity*`` functions.

.. note::
    The sensor objects stored in ``window.racecarState`` expose their payload as a
    property named ``data``.  It must NOT be named ``to_py``: Pyodide's ``JsProxy``
    already defines a ``.to_py()`` method, so naming our own accessor ``to_py``
    caused ``cam.to_py()`` to convert the *whole camera object* (including the JS
    function itself, as a ``JsProxy``) into a Python dict instead of calling the JS
    accessor.  NumPy then choked on the ``JsProxy`` with::

        TypeError: int() argument must be ... not 'pyodide.ffi.JsProxy'
"""

import js  # type: ignore
import numpy as np  # type: ignore
from enum import IntEnum
from pyodide.ffi import create_proxy  # type: ignore


################################################################################
# JS <-> Python data conversion helpers
################################################################################


def _js_to_python(raw):
    """
    Best-effort conversion of a JsProxy-wrapped JS value into a Python value.

    A JsProxy wrapping a JS TypedArray/Array/Object is converted with its
    ``to_py()`` method.  Plain Python objects are returned unchanged.
    """
    if raw is None:
        return None
    try:
        if hasattr(raw, "to_py"):
            return raw.to_py()
    except Exception:
        pass
    return raw


def _to_array(raw, dtype):
    """
    Convert raw JS sensor data (TypedArray, Array, or plain object) into a numpy
    array of the requested dtype.  Returns ``None`` if the data is unusable.
    """
    py = _js_to_python(raw)
    if py is None:
        return None
    # Unity may marshal a byte array as a plain JS object (dict keyed by index).
    if isinstance(py, dict):
        py = list(py.values())
    try:
        arr = np.asarray(py, dtype=dtype)
    except Exception:
        try:
            arr = np.frombuffer(bytes(py), dtype=dtype)
        except Exception:
            return None
    # np.asarray() over a memoryview/bytes buffer can yield a read-only view,
    # but the physical library returns writable arrays; normalize so user code
    # that mutates a returned scan/image never hits a read-only error.
    if not arr.flags.writeable:
        arr = arr.copy()
    return arr


################################################################################
# Drive
################################################################################


class Drive:
    def set_speed_angle(self, speed, angle):
        js.window.unitySetDrive(speed, angle)

    def stop(self):
        js.window.unityStopDrive()

    def set_max_speed(self, max_speed):
        js.window.unitySetMaxSpeed(max_speed)


################################################################################
# Lidar
################################################################################


class Lidar:
    def _samples(self):
        """Return the raw lidar samples pushed by Unity, or None."""
        try:
            if not hasattr(js.window, "racecarState"):
                return None
            state = js.window.racecarState
            if not hasattr(state, "lidar"):
                return None
            return _to_array(state.lidar.data, np.float32)
        except Exception:
            return None

    def get_samples(self):
        samples = self._samples()
        if samples is None or samples.size == 0:
            return np.zeros(360, dtype=np.float32)
        return samples

    def get_num_samples(self):
        samples = self._samples()
        if samples is not None and samples.size > 0:
            return int(samples.size)
        return 360

    def get_samples_async(self):
        return self.get_samples()


################################################################################
# Camera
################################################################################


class Camera:
    def _dims(self):
        """Return (width, height) of the color camera, defaulting to 640x480."""
        w, h = 640, 480
        try:
            if not hasattr(js.window, "racecarState"):
                return w, h
            state = js.window.racecarState
            if not hasattr(state, "camera"):
                return w, h
            cam = state.camera
            w = int(cam.w)
            h = int(cam.h)
        except Exception:
            pass
        return w, h

    def _color_data(self):
        """Return the raw RGBA color bytes as a flat uint8 numpy array, or None."""
        try:
            if not hasattr(js.window, "racecarState"):
                return None
            state = js.window.racecarState
            if not hasattr(state, "camera"):
                return None
            return _to_array(state.camera.data, np.uint8)
        except Exception:
            return None

    def get_color_image(self):
        w, h = self._dims()
        arr = self._color_data()
        if arr is None or arr.size != h * w * 4:
            return np.zeros((h, w, 3), dtype=np.uint8)

        arr = arr.reshape((h, w, 4))
        # Unity supplies RGBA; OpenCV expects BGR.
        bgr = np.empty((h, w, 3), dtype=np.uint8)
        bgr[..., 0] = arr[..., 2]  # B
        bgr[..., 1] = arr[..., 1]  # G
        bgr[..., 2] = arr[..., 0]  # R
        return bgr

    def get_color_image_no_copy(self):
        return self.get_color_image()

    def get_color_image_async(self):
        return self.get_color_image()

    def get_depth_image(self):
        # Unity's browser bridge does not stream depth frames, so return a valid
        # (empty) depth image so user code that reads depth does not crash.
        w, h = self._dims()
        return np.zeros((h, w), dtype=np.float32)

    def get_depth_image_async(self):
        return self.get_depth_image()

    def get_width(self):
        return self._dims()[0]

    def get_height(self):
        return self._dims()[1]

    def get_max_range(self):
        return 1000.0


################################################################################
# Physics (IMU)
################################################################################


class Physics:
    def get_linear_acceleration(self):
        try:
            if not hasattr(js.window, "racecarState"):
                return (0.0, 0.0, 0.0)
            state = js.window.racecarState
            if not hasattr(state, "accel"):
                return (0.0, 0.0, 0.0)
            arr = _to_array(state.accel.data, np.float32)
        except Exception:
            return (0.0, 0.0, 0.0)
        if arr is None or arr.size < 3:
            return (0.0, 0.0, 0.0)
        return (float(arr[0]), float(arr[1]), float(arr[2]))

    def get_angular_velocity(self):
        try:
            if not hasattr(js.window, "racecarState"):
                return (0.0, 0.0, 0.0)
            state = js.window.racecarState
            if not hasattr(state, "gyro"):
                return (0.0, 0.0, 0.0)
            arr = _to_array(state.gyro.data, np.float32)
        except Exception:
            return (0.0, 0.0, 0.0)
        if arr is None or arr.size < 3:
            return (0.0, 0.0, 0.0)
        return (float(arr[0]), float(arr[1]), float(arr[2]))


################################################################################
# Controller
################################################################################


class Controller:
    # Enums mirror the real RACECAR-MN controller enums exactly. They are
    # IntEnums (not plain classes) so they are iterable and expose `.name`,
    # matching the physical library's behavior (e.g. ``for b in rc.controller.Button``).
    class Button(IntEnum):
        A = 0
        B = 1
        X = 2
        Y = 3
        LB = 4
        RB = 5
        LJOY = 6
        RJOY = 7
        START = 8
        BACK = 9
        # Backwards-compatible aliases for the older spelling used by some code.
        LEFT_JOYSTICK = 6
        RIGHT_JOYSTICK = 7

    class Trigger(IntEnum):
        LEFT = 0
        RIGHT = 1

    class Joystick(IntEnum):
        LEFT = 0
        RIGHT = 1

    def _ctrl(self):
        try:
            if not hasattr(js.window, "racecarState"):
                return None
            c = js.window.racecarState
            return c.controller if hasattr(c, "controller") else None
        except Exception:
            return None

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
        if not c:
            return 0.0
        return c.tl if int(trigger) == 0 else c.tr

    def get_joystick(self, joystick):
        c = self._ctrl()
        if not c:
            return (0.0, 0.0)
        return (c.jlx, c.jly) if int(joystick) == 0 else (c.jrx, c.jry)


################################################################################
# Display
################################################################################


class Display:
    def __init__(self):
        # 8x24 LED dot matrix (rows x columns), a no-op in the browser IDE.
        self._matrix = np.zeros((8, 24), dtype=np.uint8)

    def create_window(self):
        pass

    def show_image(self, image):
        pass  # browser display handled by Unity

    def show_color_image(self, image):
        pass

    def show_depth_image(self, image, max_depth=1000, points=None):
        pass

    def show_lidar(self, samples, radius=128, max_range=1000, highlighted_samples=None):
        pass

    def get_matrix(self):
        return self._matrix

    def new_matrix(self):
        return np.zeros((8, 24), dtype=np.uint8)

    def set_matrix(self, matrix):
        arr = np.asarray(matrix, dtype=np.uint8)
        if arr.size == 8 * 24:
            self._matrix = arr.reshape(8, 24)

    def set_matrix_intensity(self, intensity):
        pass

    def show_text(self, text, scroll_speed=2.0):
        pass


################################################################################
# Telemetry
################################################################################


class Telemetry:
    """
    Records and (optionally) visualizes real-time sensor data. In the browser IDE
    visualization is a no-op, but recording preserves the physical library's
    declare/record contract so user code does not crash.
    """

    def __init__(self):
        self._names = None
        self._data = []

    def declare_variables(self, *names):
        # Only the first declaration has an effect, matching the physical library.
        if self._names is not None:
            return
        self._names = list(names)

    def record(self, *values):
        if self._names is None:
            raise RuntimeError(
                "Telemetry.record() was called before Telemetry.declare_variables()."
            )
        if len(values) != len(self._names):
            raise ValueError(
                f"Telemetry.record() expected {len(self._names)} values but got {len(values)}."
            )
        self._data.append(tuple(values))

    def visualize(self):
        # No-op in the browser IDE.
        pass


################################################################################
# Racecar
################################################################################


class Racecar:
    def __init__(self):
        self.drive = Drive()
        self.lidar = Lidar()
        self.camera = Camera()
        self.physics = Physics()
        self.controller = Controller()
        self.display = Display()
        self.telemetry = Telemetry()
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
        try:
            js.window._rc_updateSlowTime = self._update_slow_time
        except Exception:
            pass

    def get_delta_time(self):
        return 1.0 / 60.0

    def go(self):
        pass


def create_racecar(_isSimulation=None):
    return Racecar()

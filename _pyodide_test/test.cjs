// Real Pyodide runtime test: prove the `to_py` collision root cause and verify
// the fixed racecar_core.py reads sensor data correctly.
const { loadPyodide } = require("pyodide");
const fs = require("fs");

(async () => {
    const py = await loadPyodide();
    console.log("Pyodide loaded, version:", py.version || "unknown");

    // Expose a fake `window` and `racecarState` on globalThis so `js.window.*` works.
    globalThis.window = globalThis;

    // Load numpy (camera reshape needs it). opencv not needed for the bridge test.
    console.log("Loading numpy...");
    await py.loadPackage("numpy");
    console.log("numpy loaded");

    // Write the FIXED racecar_core.py into the Pyodide filesystem.
    const core = fs.readFileSync(
        "C:/Users/ruant/OneDrive/Documents/Racecar/ide/frontend/racecar_core.py", "utf8");
    py.FS.writeFile("/home/pyodide/racecar_core.py", core);

    // --- 1. Prove the collision: a JS object with a `to_py` key, when read via
    //        cam.to_py(), returns the WHOLE object (dict), NOT the JS function's
    //        return value. This is why the old code broke.
    const collision = await py.runPythonAsync(`
import js
# Build a JS object mimicking the OLD sensor format: { to_py: <fn>, w, h }
js.window.racecarState = js.window.__makeOldCam() if False else None
''
`);
    // (runPythonAsync can't easily call our JS maker; do it via globalThis instead)
    globalThis.racecarState = {
        to_py: () => new Uint8Array([1, 2, 3, 4]),
        w: 2, h: 2,
    };
    const probe = await py.runPythonAsync(`
import js
cam = js.window.racecarState
raw = cam.to_py()   # <-- Pyodide's own JsProxy.to_py(), NOT our JS function
print("PROBE_TYPE", type(raw).__name__)
print("PROBE_IS_DICT", isinstance(raw, dict))
print("PROBE_KEYS", sorted(raw.keys()) if isinstance(raw, dict) else None)
`);
    console.log("(probe above shows cam.to_py() returns the whole object, proving the collision)");

    // --- 2. Verify the FIXED code reads { data: Uint8Array, w, h } correctly.
    const W = 2, H = 2;
    const rgba = new Uint8Array([
        255, 0, 0, 255,   // red
        0, 255, 0, 255,   // green
        0, 0, 255, 255,   // blue
        10, 20, 30, 255,
    ]);
    globalThis.racecarState = { camera: { data: rgba, w: W, h: H } };
    globalThis.unitySetDrive = () => {};
    globalThis.unityStopDrive = () => {};
    globalThis.unitySetMaxSpeed = () => {};
    globalThis.unityRegisterRacecar = () => {};

    const result = await py.runPythonAsync(`
import racecar_core
import numpy as np
rc = racecar_core.create_racecar()
img = rc.camera.get_color_image()
print("SHAPE", img.shape)
# expected BGR: red->(0,0,255), green->(0,255,0), blue->(255,0,0)
expected = np.array([[[0,0,255],[0,255,0]], [[255,0,0],[30,20,10]]], dtype=np.uint8)
print("BGR_MATCH", np.array_equal(img, expected))
print("TOPLEFT_BGR", tuple(int(x) for x in img[0,0]))
print("WIDTH", rc.camera.get_width(), "HEIGHT", rc.camera.get_height())
`);
    // lidar test (set a Float32Array)
    globalThis.racecarState = { lidar: { data: new Float32Array([1.5, 2.5, 3.5]) } };
    const lidar = await py.runPythonAsync(`
import racecar_core
import numpy as np
rc = racecar_core.create_racecar()
s = rc.lidar.get_samples()
print("LIDAR_DTYPE", str(s.dtype))
print("LIDAR_VALS", [float(x) for x in s])
print("LIDAR_N", int(s.size))
`);
    console.log("Lidar result line above.");

    // physics via JS array
    globalThis.racecarState = { accel: { data: [1.0, 2.0, 3.0] }, gyro: { data: [4.0, 5.0, 6.0] } };
    const phys = await py.runPythonAsync(`
import racecar_core
rc = racecar_core.create_racecar()
print("ACCEL", tuple(rc.physics.get_linear_acceleration()))
print("GYRO", tuple(rc.physics.get_angular_velocity()))
`);
    console.log("Physics result line above.");

    console.log("\nDONE");
    process.exit(0);
})().catch((e) => {
    console.error("TEST FAILED:", e);
    process.exit(1);
});

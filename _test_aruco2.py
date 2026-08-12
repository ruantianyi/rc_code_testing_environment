import cv2 as cv
import numpy as np

d = cv.aruco.getPredefinedDictionary(cv.aruco.DICT_6X6_250)
m = cv.aruco.generateImageMarker(d, 7, 300)
m = cv.copyMakeBorder(m, 40, 40, 40, 40, cv.BORDER_CONSTANT, value=255)
img = cv.cvtColor(m, cv.COLOR_GRAY2BGR)
det = cv.aruco.ArucoDetector(d, cv.aruco.DetectorParameters())
corners, ids, rej = det.detectMarkers(img)
print("type corners", type(corners), "len", len(corners))
print("corners[0] type", type(corners[0]), "shape", np.asarray(corners[0]).shape)
print("ids", ids, "ids.shape", ids.shape if hasattr(ids, 'shape') else None, "ids.dtype", ids.dtype if hasattr(ids, 'dtype') else None)
print("ids[0]", ids[0], "ids[0][0]", ids[0][0] if hasattr(ids[0], '__len__') else "NOT INDEXABLE")

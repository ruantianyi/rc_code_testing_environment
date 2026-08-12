import cv2 as cv
import numpy as np

print("cv2", cv.__version__)
d = cv.aruco.getPredefinedDictionary(cv.aruco.DICT_6X6_250)
m = cv.aruco.generateImageMarker(d, 7, 300)
print("marker img shape", m.shape, "min/max", m.min(), m.max())

det = cv.aruco.ArucoDetector(d, cv.aruco.DetectorParameters())

m2 = cv.copyMakeBorder(m, 40, 40, 40, 40, cv.BORDER_CONSTANT, value=255)
img = cv.cvtColor(m2, cv.COLOR_GRAY2BGR)
corners, ids, rej = det.detectMarkers(img)
print("detect (with 40px border):", ids)

img0 = cv.cvtColor(m, cv.COLOR_GRAY2BGR)
corners0, ids0, rej0 = det.detectMarkers(img0)
print("detect (no extra border):", ids0)

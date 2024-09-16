#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon Sep 16 20:25:14 2024

@author: Tsutchy
"""

import streamlit as st
from streamlit_webrtc import webrtc_streamer
import mediapipe as mp
import cv2
import av

st.title('Face Mesh Estimation')
st.write('This app uses MediaPipe to estimate face mesh in real-time.')

# Parameters for drawing
thickness = st.slider('Drawing Thickness', min_value=1, max_value=10, value=2, step=1)
circle_radius = st.slider('Circle Radius', min_value=1, max_value=10, value=2, step=1)
min_detection_confidence = st.slider('Min Detection Confidence', min_value=0.0, max_value=1.0, value=0.5, step=0.1)
min_tracking_confidence = st.slider('Min Tracking Confidence', min_value=0.0, max_value=1.0, value=0.3, step=0.1)

# MediaPipe FaceMesh
mp_face_mesh = mp.solutions.face_mesh
mp_drawing = mp.solutions.drawing_utils
drawing_spec = mp_drawing.DrawingSpec(thickness=thickness, circle_radius=circle_radius)

def callback(frame):
    image = frame.to_ndarray(format="bgr24")
    with mp_face_mesh.FaceMesh(
        min_detection_confidence=min_detection_confidence,
        min_tracking_confidence=min_tracking_confidence) as face_mesh:
        image = cv2.flip(image, 1)
        image.flags.writeable = False
        results = face_mesh.process(image)
        image.flags.writeable = True
        if results.multi_face_landmarks:
            for face_landmarks in results.multi_face_landmarks:
                mp_drawing.draw_landmarks(
                    image=image,
                    landmark_list=face_landmarks,
                    connections=mp_face_mesh.FACEMESH_TESSELATION,
                    landmark_drawing_spec=drawing_spec,
                    connection_drawing_spec=drawing_spec
                )
        return av.VideoFrame.from_ndarray(image, format="bgr24")

# WebRTC stream
webrtc_streamer(key="face-mesh", video_frame_callback=callback, async_processing=True, 
                media_stream_constraints={'video': True, 'audio': False},
                rtc_configuration={"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]})

st.write("Created by [yourname](https://github.com/yourname)")
st.write("Repository [Streamlit-FaceMesh](https://github.com/yourname/Streamlit-FaceMesh)")

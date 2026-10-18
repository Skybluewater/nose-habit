@echo off
chcp 65001 >nul
title nose-habit
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*

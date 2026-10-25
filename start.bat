@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] Создаю виртуальное окружение...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo Не найден Python 3.10+. Установите его с https://www.python.org/downloads/ и отметьте "Add to PATH".
    pause
    exit /b 1
  )
  echo [2/3] Устанавливаю зависимости...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (pause & exit /b 1)
  echo [3/3] Скачиваю Chromium для записи клипов на сервере...
  ".venv\Scripts\python.exe" -m playwright install chromium
)

echo Запуск: http://127.0.0.1:8000  (закройте окно, чтобы остановить)
".venv\Scripts\python.exe" -m cs2demo serve --open %*
pause

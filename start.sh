#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "[1/3] Создаю виртуальное окружение..."
  python3 -m venv .venv
  echo "[2/3] Устанавливаю зависимости..."
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
  echo "[3/3] Скачиваю Chromium для записи клипов на сервере..."
  .venv/bin/python -m playwright install chromium || echo "Chromium не установлен: запись в браузере всё равно работает"
fi

exec .venv/bin/python -m cs2demo serve --open "$@"

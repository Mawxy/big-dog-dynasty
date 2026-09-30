@echo off
rem Ingest the PFF exports sitting in Downloads, commit them, and push.
rem Export from PFF first: Receiving Summary, Receiving Scheme, Rushing Summary,
rem Passing Summary, Passing Pressure. Any you skip keep their committed copy.
rem Extra arguments pass through, e.g.  ingest_pff.bat --dry-run
cd /d "%~dp0"
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% scripts\ingest_pff.py %*
echo.
pause

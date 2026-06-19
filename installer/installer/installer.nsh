; Pace Browser - Custom NSIS Installer Script
; Developed by That1Dev

!macro customHeader
  !system "echo Pace Browser Installer by That1Dev"
!macroend

!macro customInit
  ; Require Windows 10 or later
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\That1Dev\PaceBrowser" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "Software\That1Dev\PaceBrowser" "Version" "1.0.0"
  WriteRegStr HKCU "Software\That1Dev\PaceBrowser" "Publisher" "That1Dev"
  ; Register pace:// protocol handler
  WriteRegStr HKCU "Software\Classes\PaceBrowser" "" "URL:Pace Browser Protocol"
  WriteRegStr HKCU "Software\Classes\PaceBrowser" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\PaceBrowser\shell\open\command" "" '"$INSTDIR\Pace Browser.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\That1Dev\PaceBrowser"
  DeleteRegKey HKCU "Software\Classes\PaceBrowser"
!macroend

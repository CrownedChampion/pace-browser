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
  WriteRegStr HKCU "Software\That1Dev\PaceBrowser" "Publisher" "That1Dev"

  ; Register pace:// protocol handler
  WriteRegStr HKCU "Software\Classes\PaceBrowser" "" "URL:Pace Browser Protocol"
  WriteRegStr HKCU "Software\Classes\PaceBrowser" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\PaceBrowser\shell\open\command" "" '"$INSTDIR\Pace Browser.exe" "%1"'

  ; ---- Default-browser capabilities (lets Windows offer Pace as a default browser) ----
  ; Application registration
  WriteRegStr HKCU "Software\Classes\PaceHTML" "" "Pace Browser Document"
  WriteRegStr HKCU "Software\Classes\PaceHTML\shell\open\command" "" '"$INSTDIR\Pace Browser.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\PaceHTML\DefaultIcon" "" '"$INSTDIR\Pace Browser.exe",0'

  ; Capabilities block consumed by Windows "Default Apps"
  WriteRegStr HKCU "Software\PaceBrowser\Capabilities" "ApplicationName" "Pace Browser"
  WriteRegStr HKCU "Software\PaceBrowser\Capabilities" "ApplicationDescription" "A fast, modern web browser."
  WriteRegStr HKCU "Software\PaceBrowser\Capabilities\StartMenu" "StartMenuInternet" "Pace Browser"
  WriteRegStr HKCU "Software\PaceBrowser\Capabilities\URLAssociations" "http"  "PaceHTML"
  WriteRegStr HKCU "Software\PaceBrowser\Capabilities\URLAssociations" "https" "PaceHTML"
  WriteRegStr HKCU "Software\PaceBrowser\Capabilities\FileAssociations" ".html" "PaceHTML"
  WriteRegStr HKCU "Software\PaceBrowser\Capabilities\FileAssociations" ".htm"  "PaceHTML"

  ; StartMenuInternet registration (required for browser default registration)
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pace Browser" "" "Pace Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pace Browser\Capabilities" "ApplicationName" "Pace Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pace Browser\Capabilities" "ApplicationDescription" "A fast, modern web browser."
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pace Browser\Capabilities\URLAssociations" "http"  "PaceHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pace Browser\Capabilities\URLAssociations" "https" "PaceHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pace Browser\shell\open\command" "" '"$INSTDIR\Pace Browser.exe"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pace Browser\DefaultIcon" "" '"$INSTDIR\Pace Browser.exe",0'

  ; Register the app's capabilities with Windows
  WriteRegStr HKCU "Software\RegisteredApplications" "Pace Browser" "Software\PaceBrowser\Capabilities"

  ; Offer to open Windows "Default Apps" so the user can pick Pace as default.
  MessageBox MB_YESNO|MB_ICONQUESTION "Set Pace Browser as your default browser?$\r$\n$\r$\nWindows will open the Default Apps settings where you can choose Pace Browser." IDNO skipDefault
    ExecShell "open" "ms-settings:defaultapps"
  skipDefault:
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\That1Dev\PaceBrowser"
  DeleteRegKey HKCU "Software\Classes\PaceBrowser"
  DeleteRegKey HKCU "Software\Classes\PaceHTML"
  DeleteRegKey HKCU "Software\PaceBrowser"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Pace Browser"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Pace Browser"
!macroend

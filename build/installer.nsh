!include "nsProcess.nsh"

!macro customCheckAppRunning
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Goto fyow_check_app_done
  ${EndIf}

  fyow_check_app_retry:
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    ${IfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK fyow_check_app_close IDCANCEL fyow_check_app_cancel
    ${EndIf}

    fyow_check_app_close:
    DetailPrint "$(appClosing)"
    ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 800
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      Sleep 800
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY fyow_check_app_retry IDCANCEL fyow_check_app_cancel
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Goto fyow_check_app_done

  fyow_check_app_cancel:
  ${nsProcess::Unload}
  Quit

  fyow_check_app_done:
  ${nsProcess::Unload}
!macroend

!macro customInstall
  ${If} ${isUpdated}
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend

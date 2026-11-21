# EvoWork Windows 安装向导定制（配合 build/electron-builder.yml 的 nsis 配置）。
#
# 1. 许可协议页采用「我接受 / 我不接受」单选框（MUI_LICENSEPAGE_RADIOBUTTONS），未勾选接受前禁用「下一步」。
# 2. 默认走当前用户安装（免管理员 UAC，普通办公机可直接安装，同时支持点「浏览」改装到 D 盘等任意目录）；
#    管理员仍可通过 `/allusers` 显式进行全机部署，已有全机安装升级时保留原模式。
# 3. 选择安装目录后展示「选择附加任务」页，允许用户自主勾选桌面快捷方式与开始菜单快捷方式；
#    应用内在线升级（`--updated --force-run /S`）自动跳过所有向导页，按原目录与原快捷方式偏好静默覆盖并重开。

!ifndef BUILD_UNINSTALLER
  !define MUI_LICENSEPAGE_RADIOBUTTONS

  Var wantDesktopShortcut
  Var wantStartMenuShortcut
  Var shortcutPageDialog
  Var shortcutLabelControl
  Var desktopShortcutCheckbox
  Var startMenuShortcutCheckbox
!endif

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    LangString ADDITIONAL_TASKS_TITLE ${LANG_SIMPCHINESE} "选择附加任务"
    LangString ADDITIONAL_TASKS_TITLE ${LANG_ENGLISH} "Select Additional Tasks"
    LangString ADDITIONAL_TASKS_SUBTITLE ${LANG_SIMPCHINESE} "安装 ${PRODUCT_NAME} 时需要执行哪些附加任务？"
    LangString ADDITIONAL_TASKS_SUBTITLE ${LANG_ENGLISH} "Which additional tasks should be performed while installing ${PRODUCT_NAME}?"
    LangString ADDITIONAL_TASKS_HINT ${LANG_SIMPCHINESE} "选择安装 ${PRODUCT_NAME} 时您希望安装程序执行的附加任务，然后单击“下一步”。"
    LangString ADDITIONAL_TASKS_HINT ${LANG_ENGLISH} "Select the additional tasks you would like Setup to perform while installing ${PRODUCT_NAME}, then click Next."
    LangString ADDITIONAL_ICONS_GROUP ${LANG_SIMPCHINESE} "附加快捷方式："
    LangString ADDITIONAL_ICONS_GROUP ${LANG_ENGLISH} "Additional shortcuts:"
    LangString CREATE_DESKTOP_SHORTCUT_LABEL ${LANG_SIMPCHINESE} "创建桌面快捷方式(&D)"
    LangString CREATE_DESKTOP_SHORTCUT_LABEL ${LANG_ENGLISH} "Create a &desktop shortcut"
    LangString CREATE_STARTMENU_SHORTCUT_LABEL ${LANG_SIMPCHINESE} "创建“开始”菜单快捷方式(&S)"
    LangString CREATE_STARTMENU_SHORTCUT_LABEL ${LANG_ENGLISH} "Create a &Start Menu shortcut"
  !endif
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${ifNot} ${isForAllUsers}
    ${andIf} $hasPerMachineInstallation != "1"
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  !endif
!macroend

!macro customInit
  StrCpy $wantDesktopShortcut "1"
  StrCpy $wantStartMenuShortcut "1"
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${ifNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      StrCpy $wantDesktopShortcut "0"
    ${endIf}
    !ifdef MENU_FILENAME
      ${ifNot} ${FileExists} "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
        StrCpy $wantStartMenuShortcut "0"
      ${endIf}
    !else
      ${ifNot} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
        StrCpy $wantStartMenuShortcut "0"
      ${endIf}
    !endif
  ${endIf}
  ${if} ${isNoDesktopShortcut}
    StrCpy $wantDesktopShortcut "0"
  ${endIf}
!macroend

!macro customPageAfterChangeDir
  Page custom shortcutOptionsPageCreate shortcutOptionsPageLeave

  Function shortcutOptionsPageCreate
    ${if} ${isUpdated}
      Abort
    ${endIf}

    !insertmacro MUI_HEADER_TEXT "$(ADDITIONAL_TASKS_TITLE)" "$(ADDITIONAL_TASKS_SUBTITLE)"
    nsDialogs::Create 1018
    Pop $shortcutPageDialog
    ${If} $shortcutPageDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "$(ADDITIONAL_TASKS_HINT)"
    Pop $shortcutLabelControl

    ${NSD_CreateLabel} 0 30u 100% 12u "$(ADDITIONAL_ICONS_GROUP)"
    Pop $shortcutLabelControl

    ${NSD_CreateCheckbox} 12u 46u 280u 12u "$(CREATE_DESKTOP_SHORTCUT_LABEL)"
    Pop $desktopShortcutCheckbox
    ${If} $wantDesktopShortcut == "1"
      ${NSD_Check} $desktopShortcutCheckbox
    ${EndIf}

    ${NSD_CreateCheckbox} 12u 64u 280u 12u "$(CREATE_STARTMENU_SHORTCUT_LABEL)"
    Pop $startMenuShortcutCheckbox
    ${If} $wantStartMenuShortcut == "1"
      ${NSD_Check} $startMenuShortcutCheckbox
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function shortcutOptionsPageLeave
    ${NSD_GetState} $desktopShortcutCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $wantDesktopShortcut "1"
    ${Else}
      StrCpy $wantDesktopShortcut "0"
    ${EndIf}

    ${NSD_GetState} $startMenuShortcutCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $wantStartMenuShortcut "1"
    ${Else}
      StrCpy $wantStartMenuShortcut "0"
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    ${if} $wantDesktopShortcut == "0"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endIf}
    ${if} $wantStartMenuShortcut == "0"
      WinShell::UninstShortcut "$newStartMenuLink"
      Delete "$newStartMenuLink"
      !ifdef MENU_FILENAME
        RMDir "$SMPROGRAMS\${MENU_FILENAME}"
      !endif
      StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${endIf}
  ${endIf}
!macroend

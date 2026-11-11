# Types text into the first text field of the app's window and presses Enter,
# through UI Automation (the WebView2 page exposes its accessibility tree).
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Text)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -Namespace Smoke -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);'

$handle = (Get-Process -Id $ProcessId).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'The app has no main window' }
[Smoke.Native]::SetForegroundWindow($handle) | Out-Null
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$isEdit = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$field = $null
for ($attempt = 0; $attempt -lt 40 -and -not $field; $attempt++) {
  $field = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $isEdit)
  if (-not $field) { Start-Sleep -Milliseconds 500 }
}
if (-not $field) { throw 'No text field in the app window' }
Write-Output "Typing into: $($field.Current.Name)"
$field.SetFocus()
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait($Text)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

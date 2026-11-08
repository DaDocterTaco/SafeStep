param([Parameter(Mandatory)][int]$BrowserProcessId,[Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference='Stop'
$extension=(Resolve-Path -LiteralPath $Directory).Path
if (!(Test-Path -LiteralPath (Join-Path $extension 'manifest.json'))) {throw 'Extension manifest is missing.'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$auto=[Windows.Automation.AutomationElement]
$scope=[Windows.Automation.TreeScope]
$button=New-Object Windows.Automation.PropertyCondition($auto::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
$edit=New-Object Windows.Automation.PropertyCondition($auto::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
$end=[DateTime]::UtcNow.AddSeconds(15)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SafeStepOwnedWindow {
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}
'@
$seen=@{}
do {
  $chromeProcesses=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,ParentProcessId
  $owned=@($BrowserProcessId)
  for($n=0;$n -lt 5;$n++) {$owned=@($owned+$chromeProcesses.Where({$owned -contains $_.ParentProcessId}).ProcessId|Where-Object {$_}|Sort-Object -Unique)}
  foreach ($window in $auto::RootElement.FindAll($scope::Children,[Windows.Automation.Condition]::TrueCondition)) {
    $ours=$owned -contains $window.Current.ProcessId
    $handle=[IntPtr]($window.Current.NativeWindowHandle)
    for($n=0;!$ours -and $handle -ne [IntPtr]::Zero -and $n -lt 12;$n++){
      $handle=[SafeStepOwnedWindow]::GetWindow($handle,4)
      [uint32]$ownerPid=0
      if($handle -ne [IntPtr]::Zero){[void][SafeStepOwnedWindow]::GetWindowThreadProcessId($handle,[ref]$ownerPid);$ours=$owned -contains $ownerPid}
    }
    if(!$ours){continue}
    $options=@($window.FindAll($scope::Descendants,$button))
    $isDialog=$window.Current.ClassName -eq '#32770'
    $seen[$window.Current.ClassName]=if($isDialog){'buttons='+(@($options|ForEach-Object {$_.Current.Name}) -join ',')+'; edits='+(@($window.FindAll($scope::Descendants,$edit)|ForEach-Object {$_.Current.Name+'/'+$_.Current.AutomationId}) -join ',')}else{'opened; picker-related controls='+(@($options|ForEach-Object {$_.Current.Name}|Where-Object {$_ -match 'Cancel|Open|Select|Folder|Load unpacked|Developer mode'}) -join ',')}
    $select=@($options|Where-Object {$_.Current.Name -match '^Select Folder$|^Select directory$|^Select$|^Open$' -and $_.Current.IsEnabled})|Select-Object -First 1
    if (!$select -or !($options|Where-Object {$_.Current.Name -eq 'Cancel'})) {continue}
    $folder=@($window.FindAll($scope::Descendants,$edit) | Where-Object {$_.Current.IsEnabled -and ($_.Current.Name -match '^Folder:?$|^File name:?$' -or $_.Current.AutomationId -in '1148','1152','1001')}) | Select-Object -First 1
    if (!$folder) {continue}
    $value=$folder.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($extension)
    if ($value.Current.Value -ne $extension) {throw 'The picker did not contain the exact release directory.'}
    $select.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    'Selected the identified extension folder in the disposable Chrome process.'
    exit 0
  }
  Start-Sleep -Milliseconds 150
} while([DateTime]::UtcNow -lt $end)
throw ('No matching Select Folder dialog in this disposable Chrome process: '+($seen|ConvertTo-Json -Compress))

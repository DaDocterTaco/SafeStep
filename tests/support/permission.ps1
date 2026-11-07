# Respond ONLY to a permission bubble in the disposable Chrome instance launched by chrome.mjs.
param([Parameter(Mandatory)][int]$BrowserProcessId,[Parameter(Mandatory)][ValidateSet('Allow','Deny')][string]$Choice)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$auto=[Windows.Automation.AutomationElement]
$tree=[Windows.Automation.TreeScope]
$pidCondition=New-Object Windows.Automation.PropertyCondition($auto::ProcessIdProperty,$BrowserProcessId)
$buttonCondition=New-Object Windows.Automation.PropertyCondition($auto::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
$names=if($Choice -eq 'Deny'){@('Deny','Cancel','Don’t allow',"Don't allow")}else{@('Allow','Grant')}
$end=[datetime]::UtcNow.AddSeconds(8)
$invoked=$false
do {
  $bubble=$false
  $windows=$auto::RootElement.FindAll($tree::Children,$pidCondition)
  foreach($window in $windows){
    $buttons=$window.FindAll($tree::Descendants,$buttonCondition)
    $labels=@($buttons | ForEach-Object {$_.Current.Name})
    # Both alternatives must be present; never click a page's unrelated Cancel button.
    if(($labels -notcontains 'Allow') -and ($labels -notcontains 'Grant')){continue}
    $bubble=$true
    if(!$shownAt){$shownAt=[datetime]::UtcNow}
    if(([datetime]::UtcNow-$shownAt).TotalMilliseconds -lt 1100){continue}
    foreach($b in $buttons){
      $label=$b.Current.Name
      if(($names -contains $label) -and $b.Current.IsEnabled){
        try{
          $invoke=$b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
          $invoke.Invoke();$invoked=$true
        }catch [System.Windows.Automation.ElementNotEnabledException]{continue}
      }
    }
  }
  if($invoked -and !$bubble){Write-Output ('Native Chrome permission choice: '+$Choice);exit 0}
  Start-Sleep -Milliseconds 100
} while([datetime]::UtcNow -lt $end)
throw ('Chrome permission prompt not available. Test-profile button labels: '+($labels -join ', '))

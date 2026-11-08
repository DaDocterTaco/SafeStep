param(
    [Parameter(Mandatory=$true)][string]$PageImage,
    [Parameter(Mandatory=$true)][string]$PanelImage,
    [Parameter(Mandatory=$true)][string]$Destination,
    [ValidateSet('left','right')][string]$PanelSide='right'
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$page=[System.Drawing.Bitmap]::new($PageImage)
try {
    $panel=[System.Drawing.Bitmap]::new($PanelImage)
    try {
        $output=[System.Drawing.Bitmap]::new($page.Width+$panel.Width,[Math]::Max($page.Height,$panel.Height))
        try {
            $graphics=[System.Drawing.Graphics]::FromImage($output)
            try {
                $graphics.Clear([System.Drawing.Color]::White)
                if ($PanelSide -eq 'left') {
                    $graphics.DrawImageUnscaled($panel,0,0)
                    $graphics.DrawImageUnscaled($page,$panel.Width,0)
                } else {
                    $graphics.DrawImageUnscaled($page,0,0)
                    $graphics.DrawImageUnscaled($panel,$page.Width,0)
                }
                $output.Save($Destination,[System.Drawing.Imaging.ImageFormat]::Png)
            } finally { $graphics.Dispose() }
        } finally { $output.Dispose() }
    } finally { $panel.Dispose() }
} finally { $page.Dispose() }

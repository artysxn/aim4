# AIM4 local demo parser - drag-and-drop GUI for Windows.
# Launched by parse-demo.bat. Calls tools/parse-demo-local.js for the real work.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ToolsDir
$ParseScript = Join-Path $ToolsDir 'parse-demo-local.js'

$Bg        = [System.Drawing.Color]::FromArgb(18, 20, 24)
$Surface   = [System.Drawing.Color]::FromArgb(28, 32, 38)
$Surface2  = [System.Drawing.Color]::FromArgb(36, 42, 50)
$Border    = [System.Drawing.Color]::FromArgb(70, 78, 90)
$Accent    = [System.Drawing.Color]::FromArgb(210, 140, 55)
$Text      = [System.Drawing.Color]::FromArgb(230, 232, 236)
$Muted     = [System.Drawing.Color]::FromArgb(150, 156, 166)
$Ok        = [System.Drawing.Color]::FromArgb(110, 180, 120)
$Err       = [System.Drawing.Color]::FromArgb(220, 100, 90)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AIM4 Demo Parser'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(720, 560)
$form.MinimumSize = New-Object System.Drawing.Size(560, 420)
$form.BackColor = $Bg
$form.ForeColor = $Text
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.AllowDrop = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = 'AIM4'
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 22)
$title.ForeColor = $Accent
$title.Location = New-Object System.Drawing.Point(24, 16)
$title.AutoSize = $true
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Local demo parser - drop .dem files, upload the .aim4replay on the site'
$subtitle.ForeColor = $Muted
$subtitle.Location = New-Object System.Drawing.Point(24, 54)
$subtitle.AutoSize = $true
$form.Controls.Add($subtitle)

$drop = New-Object System.Windows.Forms.Panel
$drop.Location = New-Object System.Drawing.Point(24, 88)
$drop.Size = New-Object System.Drawing.Size(656, 120)
$drop.Anchor = 'Top,Left,Right'
$drop.BackColor = $Surface
$drop.AllowDrop = $true
$form.Controls.Add($drop)

# Dashed border drawn manually
$drop.Add_Paint({
  param($sender, $e)
  $pen = New-Object System.Drawing.Pen $Border, 2
  $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
  $rect = New-Object System.Drawing.Rectangle 4, 4, ($sender.Width - 9), ($sender.Height - 9)
  $e.Graphics.DrawRectangle($pen, $rect)
  $pen.Dispose()
})

$dropLabel = New-Object System.Windows.Forms.Label
$dropLabel.Text = "Drop .dem files here`r`nor click to browse"
$dropLabel.TextAlign = 'MiddleCenter'
$dropLabel.Dock = 'Fill'
$dropLabel.ForeColor = $Muted
$dropLabel.Font = New-Object System.Drawing.Font('Segoe UI', 12)
$dropLabel.BackColor = [System.Drawing.Color]::Transparent
$dropLabel.AllowDrop = $true
$drop.Controls.Add($dropLabel)

$list = New-Object System.Windows.Forms.ListView
$list.Location = New-Object System.Drawing.Point(24, 220)
$list.Size = New-Object System.Drawing.Size(656, 140)
$list.Anchor = 'Top,Left,Right'
$list.View = 'Details'
$list.FullRowSelect = $true
$list.HeaderStyle = 'Nonclickable'
$list.BackColor = $Surface
$list.ForeColor = $Text
$list.BorderStyle = 'FixedSingle'
$list.Columns.Add('Demo', 360) | Out-Null
$list.Columns.Add('Status', 280) | Out-Null
$form.Controls.Add($list)

$besideRadio = New-Object System.Windows.Forms.RadioButton
$besideRadio.Text = 'Save .aim4replay next to each .dem'
$besideRadio.Location = New-Object System.Drawing.Point(24, 372)
$besideRadio.AutoSize = $true
$besideRadio.Checked = $true
$besideRadio.ForeColor = $Text
$besideRadio.Anchor = 'Bottom,Left'
$form.Controls.Add($besideRadio)

$folderRadio = New-Object System.Windows.Forms.RadioButton
$folderRadio.Text = 'Save all to folder:'
$folderRadio.Location = New-Object System.Drawing.Point(24, 398)
$folderRadio.AutoSize = $true
$folderRadio.ForeColor = $Text
$folderRadio.Anchor = 'Bottom,Left'
$form.Controls.Add($folderRadio)

$outBox = New-Object System.Windows.Forms.TextBox
$outBox.Location = New-Object System.Drawing.Point(170, 396)
$outBox.Size = New-Object System.Drawing.Size(400, 24)
$outBox.Anchor = 'Bottom,Left,Right'
$outBox.BackColor = $Surface2
$outBox.ForeColor = $Text
$outBox.BorderStyle = 'FixedSingle'
$form.Controls.Add($outBox)

$browseBtn = New-Object System.Windows.Forms.Button
$browseBtn.Text = 'Browse...'
$browseBtn.Location = New-Object System.Drawing.Point(580, 394)
$browseBtn.Size = New-Object System.Drawing.Size(100, 28)
$browseBtn.Anchor = 'Bottom,Right'
$browseBtn.FlatStyle = 'Flat'
$browseBtn.BackColor = $Surface2
$browseBtn.ForeColor = $Text
$browseBtn.FlatAppearance.BorderColor = $Border
$form.Controls.Add($browseBtn)

$parseBtn = New-Object System.Windows.Forms.Button
$parseBtn.Text = 'Parse'
$parseBtn.Location = New-Object System.Drawing.Point(24, 440)
$parseBtn.Size = New-Object System.Drawing.Size(110, 34)
$parseBtn.Anchor = 'Bottom,Left'
$parseBtn.FlatStyle = 'Flat'
$parseBtn.BackColor = $Accent
$parseBtn.ForeColor = [System.Drawing.Color]::FromArgb(20, 16, 10)
$parseBtn.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$parseBtn.FlatAppearance.BorderSize = 0
$form.Controls.Add($parseBtn)

$clearBtn = New-Object System.Windows.Forms.Button
$clearBtn.Text = 'Clear'
$clearBtn.Location = New-Object System.Drawing.Point(144, 440)
$clearBtn.Size = New-Object System.Drawing.Size(90, 34)
$clearBtn.Anchor = 'Bottom,Left'
$clearBtn.FlatStyle = 'Flat'
$clearBtn.BackColor = $Surface2
$clearBtn.ForeColor = $Text
$clearBtn.FlatAppearance.BorderColor = $Border
$form.Controls.Add($clearBtn)

$openBtn = New-Object System.Windows.Forms.Button
$openBtn.Text = 'Open last output'
$openBtn.Location = New-Object System.Drawing.Point(244, 440)
$openBtn.Size = New-Object System.Drawing.Size(140, 34)
$openBtn.Anchor = 'Bottom,Left'
$openBtn.FlatStyle = 'Flat'
$openBtn.BackColor = $Surface2
$openBtn.ForeColor = $Text
$openBtn.FlatAppearance.BorderColor = $Border
$openBtn.Enabled = $false
$form.Controls.Add($openBtn)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Ready - drag demos onto this window'
$status.Location = New-Object System.Drawing.Point(400, 446)
$status.Size = New-Object System.Drawing.Size(280, 24)
$status.Anchor = 'Bottom,Right'
$status.ForeColor = $Muted
$status.TextAlign = 'MiddleRight'
$form.Controls.Add($status)

$script:Queue = New-Object System.Collections.Generic.List[string]
$script:LastOutDir = $null
$script:Busy = $false

function Set-DropHighlight([bool]$on) {
  if ($on) {
    $drop.BackColor = $Surface2
    $dropLabel.ForeColor = $Accent
  } else {
    $drop.BackColor = $Surface
    $dropLabel.ForeColor = $Muted
  }
  $drop.Invalidate()
}

function Add-Demos([string[]]$paths) {
  foreach ($p in $paths) {
    if (-not $p) { continue }
    $full = [System.IO.Path]::GetFullPath($p)
    if (-not (Test-Path -LiteralPath $full)) { continue }
    if ($full -notmatch '\.dem$') { continue }
    if ($script:Queue -contains $full) { continue }
    $script:Queue.Add($full) | Out-Null
    $item = New-Object System.Windows.Forms.ListViewItem ([System.IO.Path]::GetFileName($full))
    $item.SubItems.Add('Queued') | Out-Null
    $item.Tag = $full
    $list.Items.Add($item) | Out-Null
  }
  if ($script:Queue.Count -gt 0) {
    $status.Text = "$($script:Queue.Count) demo(s) ready"
    $status.ForeColor = $Muted
  }
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Invoke-Parse {
  if ($script:Busy) { return }
  if ($script:Queue.Count -eq 0) {
    [System.Windows.Forms.MessageBox]::Show(
      'Drop one or more .dem files first.',
      'AIM4 Demo Parser',
      'OK',
      'Information'
    ) | Out-Null
    return
  }

  $node = Find-Node
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show(
      "Node.js was not found on PATH.`nInstall Node 20+ from https://nodejs.org/",
      'AIM4 Demo Parser',
      'OK',
      'Error'
    ) | Out-Null
    return
  }
  if (-not (Test-Path -LiteralPath $ParseScript)) {
    [System.Windows.Forms.MessageBox]::Show(
      "Missing parser script:`n$ParseScript",
      'AIM4 Demo Parser',
      'OK',
      'Error'
    ) | Out-Null
    return
  }

  $outDir = $null
  if ($folderRadio.Checked) {
    $outDir = $outBox.Text.Trim()
    if (-not $outDir) {
      [System.Windows.Forms.MessageBox]::Show(
        'Choose an output folder, or save next to each .dem.',
        'AIM4 Demo Parser',
        'OK',
        'Warning'
      ) | Out-Null
      return
    }
    if (-not (Test-Path -LiteralPath $outDir)) {
      New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }
  }

  $script:Busy = $true
  $parseBtn.Enabled = $false
  $clearBtn.Enabled = $false
  $drop.AllowDrop = $false
  $form.AllowDrop = $false

  $ok = 0
  $fail = 0
  $lastDir = $null

  for ($i = 0; $i -lt $list.Items.Count; $i++) {
    $item = $list.Items[$i]
    $dem = [string]$item.Tag
    if ($item.SubItems[1].Text -eq 'Done') { $ok++; continue }

    $item.SubItems[1].Text = 'Parsing...'
    $item.ForeColor = $Accent
    $status.Text = "Parsing $($i + 1) / $($list.Items.Count)..."
    $status.ForeColor = $Accent
    [System.Windows.Forms.Application]::DoEvents()

    # Quote paths for Windows PowerShell 5.1 ProcessStartInfo.
    $argStr = '"' + $ParseScript + '" "' + $dem + '"'
    if ($outDir) {
      $argStr += ' -o "' + $outDir + '"'
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = $argStr
    $psi.WorkingDirectory = $RepoRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

    if ($proc.ExitCode -eq 0) {
      $item.SubItems[1].Text = 'Done'
      $item.ForeColor = $Ok
      $ok++
      if ($outDir) {
        $lastDir = $outDir
      } else {
        $lastDir = [System.IO.Path]::GetDirectoryName($dem)
      }
    } else {
      $msg = ($stderr + $stdout).Trim()
      if ($msg.Length -gt 120) { $msg = $msg.Substring(0, 117) + '...' }
      if (-not $msg) { $msg = "exit $($proc.ExitCode)" }
      $item.SubItems[1].Text = "Failed - $msg"
      $item.ForeColor = $Err
      $fail++
    }
    [System.Windows.Forms.Application]::DoEvents()
  }

  $script:LastOutDir = $lastDir
  $openBtn.Enabled = [bool]$lastDir
  $script:Busy = $false
  $parseBtn.Enabled = $true
  $clearBtn.Enabled = $true
  $drop.AllowDrop = $true
  $form.AllowDrop = $true

  if ($fail -eq 0) {
    $status.Text = "Finished - $ok package(s) ready to upload"
    $status.ForeColor = $Ok
  } else {
    $status.Text = "Finished - $ok ok, $fail failed"
    $status.ForeColor = $Err
  }
}

function Handle-DragEnter($e) {
  if ($script:Busy) { return }
  if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
    Set-DropHighlight $true
  } else {
    $e.Effect = [System.Windows.Forms.DragDropEffects]::None
  }
}

function Handle-DragDrop($e) {
  Set-DropHighlight $false
  if ($script:Busy) { return }
  $files = @($e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop))
  Add-Demos $files
}

$drop.Add_DragEnter({ Handle-DragEnter $_ })
$drop.Add_DragLeave({ Set-DropHighlight $false })
$drop.Add_DragDrop({ Handle-DragDrop $_ })
$dropLabel.Add_DragEnter({ Handle-DragEnter $_ })
$dropLabel.Add_DragLeave({ Set-DropHighlight $false })
$dropLabel.Add_DragDrop({ Handle-DragDrop $_ })
$form.Add_DragEnter({ Handle-DragEnter $_ })
$form.Add_DragLeave({ Set-DropHighlight $false })
$form.Add_DragDrop({ Handle-DragDrop $_ })

$browseDialog = New-Object System.Windows.Forms.OpenFileDialog
$browseDialog.Filter = 'CS2 demos (*.dem)|*.dem'
$browseDialog.Multiselect = $true
$browseDialog.Title = 'Select demos to parse'

$dropLabel.Add_Click({
  if ($script:Busy) { return }
  if ($browseDialog.ShowDialog() -eq 'OK') {
    Add-Demos $browseDialog.FileNames
  }
})
$drop.Add_Click({
  if ($script:Busy) { return }
  if ($browseDialog.ShowDialog() -eq 'OK') {
    Add-Demos $browseDialog.FileNames
  }
})

$folderDialog = New-Object System.Windows.Forms.FolderBrowserDialog
$folderDialog.Description = 'Folder for .aim4replay packages'

$browseBtn.Add_Click({
  if ($folderDialog.ShowDialog() -eq 'OK') {
    $outBox.Text = $folderDialog.SelectedPath
    $folderRadio.Checked = $true
  }
})

$parseBtn.Add_Click({ Invoke-Parse })
$clearBtn.Add_Click({
  if ($script:Busy) { return }
  $script:Queue.Clear()
  $list.Items.Clear()
  $status.Text = 'Ready - drag demos onto this window'
  $status.ForeColor = $Muted
  $openBtn.Enabled = $false
})
$openBtn.Add_Click({
  if ($script:LastOutDir -and (Test-Path -LiteralPath $script:LastOutDir)) {
    Start-Process explorer.exe $script:LastOutDir
  }
})

# Files dragged onto the .bat / shortcut arrive as args
if ($args.Count -gt 0) {
  Add-Demos $args
}

[System.Windows.Forms.Application]::Run($form)

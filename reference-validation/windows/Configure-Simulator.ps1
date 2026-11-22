# Graphical setup for a new controlled tournament. No developer software is needed.
param([ValidateRange(1,10)][int]$Tables=1)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object System.Windows.Forms.Form
$form.Text='EightMax controlled tournament setup'
$form.ClientSize=New-Object System.Drawing.Size(480,330)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$fields=@{}
$specs=@(@('Tables',1,10,$Tables,0),@('Starting stack (BB)',1,1000,25,2),@('Small blind (BB)',0,100,0.5,2),@('Big blind (BB)',0.01,100,1,2),@('Individual ante (BB)',0,100,0.1,2))
$y=20
foreach($spec in $specs){
 $label=New-Object System.Windows.Forms.Label
 $label.Text=$spec[0];$label.Location=New-Object System.Drawing.Point(20,$y);$label.Size=New-Object System.Drawing.Size(240,24)
 $field=New-Object System.Windows.Forms.NumericUpDown
 $field.Location=New-Object System.Drawing.Point(280,$y);$field.Width=160
 $field.DecimalPlaces=$spec[4];$field.Minimum=$spec[1];$field.Maximum=$spec[2];$field.Value=$spec[3]
 if($spec[4]){$field.Increment=0.1}
 $field.AccessibleName=$spec[0];$fields[$spec[0]]=$field
 $form.Controls.Add($label);$form.Controls.Add($field);$y+=40
}
$note=New-Object System.Windows.Forms.Label
$note.Text='Eight players. Stacks persist; eliminated players sit out. Starting opens new tournaments. Stop automation before replacing tables.'
$note.Location=New-Object System.Drawing.Point(20,220);$note.Size=New-Object System.Drawing.Size(440,45);$form.Controls.Add($note)
$start=New-Object System.Windows.Forms.Button
$start.Text='Start simulator';$start.Location=New-Object System.Drawing.Point(280,280);$start.Width=160
$start.DialogResult=[System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($start);$form.AcceptButton=$start
if($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){$form.Dispose();exit 0}
$n=[int]$fields['Tables'].Value
$stack=[int]($fields['Starting stack (BB)'].Value*100)
$sb=[int]($fields['Small blind (BB)'].Value*100)
$bb=[int]($fields['Big blind (BB)'].Value*100)
$ante=[int]($fields['Individual ante (BB)'].Value*100)
$form.Dispose()
if($sb -gt $bb){throw 'Small blind must not exceed big blind.'}
$out=Join-Path $env:LOCALAPPDATA ('EightMax-Test-Workbench\Acceptance-0.36.1\manual-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
& (Join-Path $root 'runtime\node\node.exe') (Join-Path $root 'tools\test-table-035.cjs') --tables $n --stack-chips $stack --sb-chips $sb --bb-chips $bb --ante-chips $ante --oracle-dir $out --turn-delay 1500
exit $LASTEXITCODE

' Starts nightly.ts with no window: run as the signed-in user, Task Scheduler would flash a console every two hours.
' Argument 0 is the bun.exe to use. The exit code of nightly.ts becomes the task's "Last Run Result".
'
'   wscript.exe //B //Nologo <checkout>\.claude\skills\pull-plusminus-books\run-hidden.vbs <path to bun.exe>
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WScript.Quit shell.Run("""" & WScript.Arguments(0) & """ """ & here & "\nightly.ts""", 0, True)

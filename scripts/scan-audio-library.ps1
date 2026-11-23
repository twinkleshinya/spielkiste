$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static class SpielkisteLibraryScan {
  public static void Run(string root) {
    var json = new JavaScriptSerializer();
    var output = new StreamWriter(Console.OpenStandardOutput(),new System.Text.UTF8Encoding(false),65536);
    int count=0;
    var pending = new Stack<DirectoryInfo>();
    var epoch = new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc);
    pending.Push(new DirectoryInfo(root));
    while(pending.Count>0) {
      var directory=pending.Pop();
      try {
        foreach(var entry in directory.EnumerateFileSystemInfos()) {
          if((entry.Attributes & FileAttributes.ReparsePoint)!=0)continue;
          var folder=entry as DirectoryInfo;
          if(folder!=null) {pending.Push(folder);continue;}
          var file=entry as FileInfo;
          if(file==null || file.Name.StartsWith("._") || !System.Text.RegularExpressions.Regex.IsMatch(file.Extension,@"^\.(wav|mp3|flac|ogg|m4a|aif|aiff|opus)$",System.Text.RegularExpressions.RegexOptions.IgnoreCase))continue;
          output.WriteLine(json.Serialize(new {path=file.FullName,size=file.Length,mtimeMs=(file.LastWriteTimeUtc-epoch).TotalMilliseconds}));
          if(++count%256==0)output.Flush();
        }
      } catch(Exception error) {
        if(String.Equals(directory.FullName,root,StringComparison.OrdinalIgnoreCase))throw;
        output.WriteLine(json.Serialize(new {warning="Cannot read directory: "+directory.FullName+" ("+error.Message+")"}));
      }
    }
    output.Flush();
  }
}
'@
[SpielkisteLibraryScan]::Run($env:SPIELKISTE_SCAN_ROOT)

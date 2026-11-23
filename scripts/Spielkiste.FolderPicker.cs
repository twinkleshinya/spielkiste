using System;
using System.Runtime.InteropServices;
namespace Spielkiste {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialogClass {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IOleWindow {
    void GetWindow(out IntPtr window);
    void ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool enter);
  }
  [ComVisible(true), Guid("973510DB-7D7F-452B-8975-74A85828D354"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialogEvents {
    [PreserveSig] int OnFileOk(IFileOpenDialog dialog);
    [PreserveSig] int OnFolderChanging(IFileOpenDialog dialog, IShellItem folder);
    void OnFolderChange(IFileOpenDialog dialog);
    void OnSelectionChange(IFileOpenDialog dialog);
    void OnShareViolation(IFileOpenDialog dialog, IShellItem item, out uint response);
    void OnTypeChange(IFileOpenDialog dialog);
    void OnOverwrite(IFileOpenDialog dialog, IShellItem item, out uint response);
  }
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  class DialogEvents : IFileDialogEvents {
    public int OnFileOk(IFileOpenDialog dialog) { return 0; }
    public int OnFolderChanging(IFileOpenDialog dialog, IShellItem folder) { return 0; }
    public void OnFolderChange(IFileOpenDialog dialog) {
      System.IO.File.WriteAllText(FolderPicker.StagePath, "folder loaded");
      FolderPicker.EnsureVisible(dialog);
    }
    public void OnSelectionChange(IFileOpenDialog dialog) {}
    public void OnShareViolation(IFileOpenDialog dialog, IShellItem item, out uint response) { response=0; }
    public void OnTypeChange(IFileOpenDialog dialog) {}
    public void OnOverwrite(IFileOpenDialog dialog, IShellItem item, out uint response) { response=0; }
  }
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IFileDialogEvents events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, uint placement);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
  }
  public static class FolderPicker {
    internal static string StagePath;
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    internal static void EnsureVisible(IFileOpenDialog dialog) {
      try {
        IntPtr window;
        ((IOleWindow)dialog).GetWindow(out window);
        if(window != IntPtr.Zero) {
          // Restore our own dialog after a hidden launcher suppresses its first show.
          ShowWindow(window, 1);
          SetForegroundWindow(window);
        }
      } catch { /* The shell may not expose its window until the next event. */ }
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    static extern void SHCreateItemFromParsingName(string name, IntPtr bind, ref Guid iid, out IShellItem item);
    // The WinForms picker is the primary path for the web launcher. It is a
    // normal interactive Windows dialog and does not depend on a hidden
    // PowerShell host or COM dialog callbacks being delivered to the foreground.
    // It supports local drives and UNC/shared folders through the same shell
    // namespace exposed by Windows Explorer.
    static string ChooseWinForms(string title, string initialPath) {
      using (var dialog = new System.Windows.Forms.FolderBrowserDialog()) {
        dialog.Description = title;
        dialog.ShowNewFolderButton = false;
        if (!String.IsNullOrEmpty(initialPath) && System.IO.Directory.Exists(initialPath)) {
          dialog.SelectedPath = initialPath;
        }
        var result = dialog.ShowDialog();
        return result == System.Windows.Forms.DialogResult.OK && !String.IsNullOrEmpty(dialog.SelectedPath)
          ? dialog.SelectedPath
          : null;
      }
    }
    public static string Choose(string title, string initialPath, string stagePath) {
      StagePath=stagePath;
      System.IO.File.WriteAllText(stagePath, "creating Windows dialog");
      try {
        System.IO.File.WriteAllText(stagePath, "showing Windows folder dialog");
        var selected = ChooseWinForms(title, initialPath);
        System.IO.File.WriteAllText(stagePath, selected == null ? "cancelled" : "selected folder");
        return selected;
      } catch {
        // Keep the existing shell-item implementation as a fallback for
        // environments where the WinForms shell dialog is unavailable.
      }
      return ChooseCom(title, initialPath, stagePath);
    }
    static string ChooseCom(string title, string initialPath, string stagePath) {
      var dialog = (IFileOpenDialog)new FileOpenDialogClass();
      System.IO.File.WriteAllText(stagePath, "setting Windows dialog options");
      try {
        // FOS_PICKFOLDERS | FORCEFILESYSTEM | NOCHANGEDIR | PATHMUSTEXIST.
        dialog.SetOptions(0x20 | 0x40 | 0x8 | 0x800);
        dialog.SetTitle(title);
        dialog.SetOkButtonLabel("\u9009\u62e9\u6587\u4ef6\u5939");
        IShellItem folder = null;
        try {
          System.IO.File.WriteAllText(stagePath, "resolving initial folder");
          Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
          SHCreateItemFromParsingName(String.IsNullOrEmpty(initialPath) ? "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}" : initialPath, IntPtr.Zero, ref iid, out folder);
          dialog.SetFolder(folder);
        } catch { /* An unavailable initial path must not prevent selection. */ }
        finally { if(folder != null) Marshal.ReleaseComObject(folder); }
        // Let Show initialize the shell window normally. A local owner keeps
        // this modal above the browser without altering another app's window.
        using(var owner = new System.Windows.Forms.Form()) {
        owner.Text=title;
        owner.StartPosition=System.Windows.Forms.FormStartPosition.CenterScreen;
        owner.Size=new System.Drawing.Size(1,1);
        owner.TopMost=true;
        owner.ShowInTaskbar=true;
        owner.Show();
        owner.Activate();
        var events = new DialogEvents();
        uint cookie;
        dialog.Advise(events, out cookie);
        System.IO.File.WriteAllText(stagePath, "showing Windows dialog");
        int result;
        try { result = dialog.Show(owner.Handle); }
        finally { dialog.Unadvise(cookie); GC.KeepAlive(events); }
        if(result == unchecked((int)0x800704C7)) return null;
        Marshal.ThrowExceptionForHR(result);
        IShellItem selected;
        dialog.GetResult(out selected);
        try {
          IntPtr name;
          selected.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
          try { return Marshal.PtrToStringUni(name); }
          finally { Marshal.FreeCoTaskMem(name); }
        } finally { Marshal.ReleaseComObject(selected); }
        }
      } finally { Marshal.ReleaseComObject(dialog); }
    }
  }
}
public class Program {
 [System.STAThread] public static void Main(string[] args) {
  var json=new System.Web.Script.Serialization.JavaScriptSerializer();
  var req=json.Deserialize<System.Collections.Generic.Dictionary<string,string>>(System.IO.File.ReadAllText(args[0]));
  object result;
  try { var chosen=Spielkiste.FolderPicker.Choose(req["description"],req["initialPath"],req["resultPath"]+".stage");result=chosen==null?(object)new {status="cancelled"}:new {status="success",path=chosen}; }
  catch(System.Exception ex){result=new {status="failed",error=ex.Message};}
  System.IO.File.WriteAllText(req["resultPath"],json.Serialize(result));
 }
}

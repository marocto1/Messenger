package com.marocto.messenger;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.database.Cursor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashSet;
import java.util.Set;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {
  private static ShareTargetPlugin instance;
  private final Set<String> allowed = new HashSet<>();
  @Override public void load() { instance = this; }
  @Override protected void handleOnDestroy() { if (instance == this) instance = null; allowed.clear(); }
  @PluginMethod public void getInitialShare(PluginCall call) {
    call.resolve(parseIntent(getActivity().getIntent()));
    getActivity().setIntent(new Intent());
  }
  public static void handleIntent(Intent intent) {
    if (instance != null) instance.notifyListeners("shareReceived", instance.parseIntent(intent), true);
  }
  private JSObject parseIntent(Intent intent) {
    JSObject result = new JSObject(); JSArray files = new JSArray();
    if (intent != null && (Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) {
      CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
      if (text != null) result.put("text", text.toString());
      ClipData clip = intent.getClipData();
      if (clip != null) {
        for (int i=0;i<Math.min(clip.getItemCount(),20);i++) addUri(clip.getItemAt(i).getUri(),files);
      } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
        java.util.ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (uris != null) for (Uri uri : uris) { if (files.length() >= 20) break; addUri(uri,files); }
      } else addUri(intent.getParcelableExtra(Intent.EXTRA_STREAM),files);
    }
    result.put("files",files); return result;
  }
  private void addUri(Uri uri, JSArray files) {
    if (uri != null && "content".equals(uri.getScheme()) && allowed.add(uri.toString())) files.put(uri.toString());
  }
  @PluginMethod public void readSharedFile(PluginCall call) {
    String value = call.getString("uri");
    if (value == null || !allowed.remove(value)) { call.reject("Untrusted share URI"); return; }
    getBridge().execute(() -> {
      File target = null;
      try {
        Uri uri = Uri.parse(value); String name="shared-file";
        try (Cursor cursor = getContext().getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)) {
          if (cursor != null && cursor.moveToFirst()) name=cursor.getString(0);
        }
        File dir = new File(getContext().getCacheDir(),"shares"); dir.mkdirs();
        File[] old = dir.listFiles(); if (old != null) for (File file:old) if (System.currentTimeMillis()-file.lastModified()>86400000L) file.delete();
        target = File.createTempFile("share-",".bin",dir);
        try (InputStream input=getContext().getContentResolver().openInputStream(uri); FileOutputStream output=new FileOutputStream(target)) {
          if (input == null) throw new java.io.IOException("Unavailable file");
          byte[] buffer=new byte[65536]; long total=0; int length;
          while ((length=input.read(buffer))!=-1) { total+=length; if (total>512L*1024*1024) throw new java.io.IOException("File exceeds 512 MB"); output.write(buffer,0,length); }
        }
        String mime=getContext().getContentResolver().getType(uri);
        JSObject result=new JSObject(); result.put("path",Uri.fromFile(target).toString()); result.put("name",name); result.put("mimeType",mime==null?"application/octet-stream":mime); call.resolve(result);
      } catch (Exception error) { if (target!=null) target.delete(); call.reject("Cannot read shared file",error); }
    });
  }
}

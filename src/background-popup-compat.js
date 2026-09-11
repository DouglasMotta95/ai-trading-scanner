// The extension icon has a dedicated customer popup. Some Chromium variants keep
// the side-panel-on-action flag persisted after updates, which can replace the
// popup with an empty/unsupported panel. Force that behavior off every time the
// service worker starts and shortly after install/startup events.
async function keepPopupOnAction(){
  try{
    if(chrome.sidePanel?.setPanelBehavior){
      await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false});
    }
  }catch{}
}

keepPopupOnAction();
chrome.runtime.onStartup?.addListener(()=>{keepPopupOnAction()});
chrome.runtime.onInstalled.addListener(()=>{setTimeout(keepPopupOnAction,250)});

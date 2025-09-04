// background.js Background service worker for the extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Voice Translator extension installed');
  
  // Set default settings
  chrome.storage.sync.set({
    sourceLanguage: 'en-US',
    targetLanguage: 'es',
    showSidebar: true,
    autoTranslate: true
  });
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.url.includes('meet.google.com')) {
    // Toggle the voice translator
    chrome.tabs.sendMessage(tab.id, { action: 'toggleTranslator' });
  } else {
    // Show notification if not on Google Meet
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon48.png',
      title: 'Voice Translator',
      message: 'Please open Google Meet to use the voice translator.'
    });
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'getSettings':
      chrome.storage.sync.get([
        'sourceLanguage', 'targetLanguage', 'showSidebar', 'autoTranslate'
      ], (result) => {
        sendResponse(result);
      });
      return true; // Keep message channel open for async response
      
    case 'updateSettings':
      chrome.storage.sync.set(message.settings, () => {
        sendResponse({ success: true });
      });
      return true;
      
    case 'getStatus':
      // Forward status request to content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, (response) => {
            sendResponse(response);
          });
        }
      });
      return true;
      

    case 'startTranslation':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
            sendResponse(response);
          });
        }
      });
      return true;
      
    case 'stopTranslation':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
            sendResponse(response);
          });
        }
      });
      return true;
  }
});


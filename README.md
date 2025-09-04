# Real-Time Translation Chrome Extension

A powerful Chrome extension that provides real-time translation during online meetings with speaker identification capabilities. This extension breaks down language barriers in international communications while maintaining speaker context.

![Extension Demo](docs/demo.gif)

## 🌟 Features

### Real-Time Translation
- Instant speech-to-text transcription
- Automatic language detection
- Real-time translation to multiple languages
- Support for multiple speakers in conversations

### Speaker Identification
- Automatic speaker diarization
- Color-coded speaker identification
- Consistent speaker tracking throughout conversations
- Visual badges for each unique speaker

### User Interface
- Floating, draggable translation window
- Adjustable transparency
- Resizable interface
- Real-time updates with minimal latency

### Technical Features
- Low-latency audio processing
- WebSocket-based real-time communication
- Efficient memory management
- Automatic reconnection handling

## 🛠️ Technology Stack

### Core Technologies
- **Chrome Extension APIs**: For browser integration and audio capture
- **AssemblyAI**: Real-time transcription and speaker diarization
- **Groq API**: Fast and accurate translation
- **WebSocket**: Real-time communication
- **Node.js**: Proxy server implementation

### Key Components
- AudioWorklet for real-time audio processing
- WebSocket for streaming audio data
- Server-Sent Events (SSE) for real-time updates
- Custom UI components with drag-and-drop support

## 📋 Prerequisites

- Node.js (v14.0.0 or higher)
- Chrome Browser (Version 80 or higher)
- AssemblyAI API Key
- Groq API Key

## 🚀 Installation

1. Clone the repository:
\`\`\`bash
git clone https://github.com/your-username/real-time-translation-extension.git
\`\`\`

2. Install dependencies for the proxy server:
\`\`\`bash
cd real-time-translation-extension
npm install
\`\`\`

3. Configure API keys:
   - Update \`proxy-server.js\` with your AssemblyAI API key
   - Update \`content.js\` with your Groq API key

4. Load the extension in Chrome:
   - Open Chrome and navigate to \`chrome://extensions\`
   - Enable Developer Mode
   - Click "Load unpacked"
   - Select the \`extension\` folder

5. Start the proxy server:
\`\`\`bash
node proxy-server.js
\`\`\`

## 🔧 Configuration

### Extension Settings
- Source Language Selection
- Target Language Selection
- Speaker Diarization Toggle
- UI Transparency Control
- Auto-translation Toggle

### Proxy Server Configuration
\`\`\`javascript
const config = {
  PORT: 3000,
  SAMPLE_RATE: 16000,
  PUNCTUATE: true,
  FORMAT_TEXT: true,
  DISFLUENCIES: false,
  SPEAKER_LABELS: true
};
\`\`\`

## 💡 Usage

1. Click the extension icon in Chrome toolbar
2. Grant necessary audio permissions
3. Select source and target languages
4. Start translation by clicking "Start"
5. Speak or join an online meeting
6. View real-time translations in the floating window

### Keyboard Shortcuts
- **Alt + S**: Start/Stop translation
- **Alt + H**: Hide/Show floating window
- **Alt + T**: Toggle transparency
- **Esc**: Stop translation

## 🔍 Technical Details

### Audio Processing Pipeline
1. Audio capture using Chrome's audio APIs
2. Real-time processing through AudioWorklet
3. Streaming to AssemblyAI via WebSocket
4. Real-time transcription and speaker identification
5. Translation using Groq API
6. UI updates via SSE

### WebSocket Connection Management
- Automatic reconnection handling
- Error recovery mechanisms
- Connection state monitoring
- Efficient data streaming

### Speaker Identification System
- Real-time speaker diarization
- Consistent speaker tracking
- Color-coded identification
- Speaker transition handling

## 🛡️ Privacy & Security

- All audio processing is done server-side
- No audio data is stored permanently
- Secure WebSocket connections
- API keys are never exposed to end-users

## 🔄 Error Handling

The extension implements robust error handling for:
- Network disconnections
- API failures
- Audio capture issues
- Permission denials
- Memory management

## 🎯 Performance Optimization

- Efficient audio buffering
- Minimal UI updates
- Memory leak prevention
- Background process management

## 📚 Documentation

Detailed documentation is available in the \`docs\` folder:
- [Technical Documentation](docs/technical.md)
- [API Reference](docs/api.md)
- [User Guide](docs/user-guide.md)
- [Development Guide](docs/development.md)

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [AssemblyAI](https://www.assemblyai.com/) for real-time transcription
- [Groq](https://groq.com/) for fast translation services
- Chrome Extension development community
- All contributors and testers

## 🐛 Known Issues

1. Minor audio delay in high-latency networks
2. Speaker identification may take a few seconds to stabilize
3. Language detection accuracy varies with audio quality

## 🔜 Future Improvements

1. Enhanced speaker identification accuracy
2. Support for more languages
3. Offline mode capabilities
4. Advanced UI customization options
5. Meeting recording and transcript export

## 📞 Support

For support, please:
1. Check the [FAQ](docs/faq.md)
2. Search existing [Issues](https://github.com/your-username/real-time-translation-extension/issues)
3. Create a new issue if needed

## 🔄 Version History

- **v1.0.0**: Initial release with core features
- **v1.1.0**: Added speaker identification
- **v1.2.0**: UI improvements and bug fixes
- **v1.3.0**: Performance optimizations

---

Made with ❤️ by Ayush Mishra

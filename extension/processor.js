// AudioWorklet processor for real-time audio processing
class VTProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 1024;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const inputData = input[0]; // Get first channel
      
      // Fill buffer with input data
      for (let i = 0; i < inputData.length; i++) {
        this.buffer[this.bufferIndex] = inputData[i];
        this.bufferIndex++;
        
        // When buffer is full, send it
        if (this.bufferIndex >= this.bufferSize) {
          this.port.postMessage({
            type: 'audioData',
            data: new Float32Array(this.buffer)
          });
          this.bufferIndex = 0;
        }
      }
    }
    
    return true; // Keep processor alive
  }
}

registerProcessor('vt-processor', VTProcessor);

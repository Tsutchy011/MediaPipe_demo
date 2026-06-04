class FormClassifier {
    constructor() {
        this.goodFingers = []; 
        this.badFingers = [];
        this.isRecordingGood = false;
        this.isRecordingBad = false;
        this.k = 5;
    }
    
    // Normalize a single finger's joints (PIP, DIP, TIP) relative to its MCP and scale by Palm Length
    extractFeature(mcp, pip, dip, tip, palmLength) {
        if (palmLength <= 0) return null;
        
        return [
            (pip.x - mcp.x) / palmLength,
            (pip.y - mcp.y) / palmLength,
            (dip.x - mcp.x) / palmLength,
            (dip.y - mcp.y) / palmLength,
            (tip.x - mcp.x) / palmLength,
            (tip.y - mcp.y) / palmLength
        ];
    }
    
    addGoodSample(feature) {
        if (feature) this.goodFingers.push(feature);
    }
    
    addBadSample(feature) {
        if (feature) this.badFingers.push(feature);
    }
    
    clearData() {
        this.goodFingers = [];
        this.badFingers = [];
    }
    
    hasData() {
        return this.goodFingers.length > 0 && this.badFingers.length > 0;
    }
    
    getDistance(v1, v2) {
        let sum = 0;
        for (let i = 0; i < 6; i++) {
            sum += Math.pow(v1[i] - v2[i], 2);
        }
        return Math.sqrt(sum);
    }
    
    classify(feature) {
        if (!this.hasData() || !feature) return false;
        
        const distances = [];
        for (let good of this.goodFingers) {
            distances.push({ label: 'good', dist: this.getDistance(feature, good) });
        }
        for (let bad of this.badFingers) {
            distances.push({ label: 'bad', dist: this.getDistance(feature, bad) });
        }
        
        distances.sort((a, b) => a.dist - b.dist);
        
        let badCount = 0;
        const limit = Math.min(this.k, distances.length);
        for (let i = 0; i < limit; i++) {
            if (distances[i].label === 'bad') badCount++;
        }
        
        return badCount > Math.floor(limit / 2);
    }
}

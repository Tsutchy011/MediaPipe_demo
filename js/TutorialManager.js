/**
 * TutorialManager.js
 * Manages step-by-step onboarding guide with popups/overlays.
 */
window.TutorialManager = class TutorialManager {
    constructor(steps) {
        this.steps = steps || [];
        this.currentStep = 0;
        this.overlay = null;
        this.popup = null;
        this._initUI();
    }

    _initUI() {
        // Create Overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'tutorial-overlay';
        Object.assign(this.overlay.style, {
            position: 'fixed',
            top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.5)',
            zIndex: 9998,
            display: 'none',
            // pointerEvents: 'none' // REMOVE THIS: We WANT to block clicks on background
        });
        document.body.appendChild(this.overlay);

        // Create Popup Bubble
        this.popup = document.createElement('div');
        this.popup.className = 'tutorial-popup';
        Object.assign(this.popup.style, {
            position: 'absolute',
            background: 'white',
            color: '#333',
            padding: '20px',
            borderRadius: '8px',
            boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
            zIndex: 9999,
            maxWidth: '300px',
            display: 'none',
            textAlign: 'center'
        });
        document.body.appendChild(this.popup);
    }

    start() {
        if (!this.steps || this.steps.length === 0) {
            console.warn("TutorialManager: No steps defined.");
            return;
        }
        console.log("TutorialManager: Starting tutorial.");
        this.currentStep = 0;
        this.showStep(0);
    }

    showStep(index) {
        if (index >= this.steps.length) {
            this.end();
            return;
        }

        const step = this.steps[index];
        const target = step.targetId ? document.querySelector(step.targetId) : null;

        // Show Overlay
        this.overlay.style.display = 'block';

        // Content
        this.popup.innerHTML = `
            <h3 style="margin-top:0; font-size:1.1rem; color:#333;">${step.title}</h3>
            <p style="font-size:0.9rem; color:#666; line-height:1.4;">${step.text}</p>
            <div style="display:flex; justify-content:center; gap:10px; margin-top:15px;">
                <button id="tut-skip-btn" style="
                    background: transparent; color: #999; border: 1px solid #ddd; 
                    padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size:0.8rem;">
                    スキップ
                </button>
                <button id="tut-next-btn" style="
                    background: #007bff; color: white; border: none; 
                    padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size:0.9rem; font-weight:bold;">
                    ${index === this.steps.length - 1 ? '完了' : '次へ'}
                </button>
            </div>
        `;
        this.popup.style.display = 'block';

        // Positioning
        if (target) {
            const rect = target.getBoundingClientRect();
            // Simple positioning: Below the element if possible, else center
            // Add scroll to view
            target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

            // Wait a bit for scroll?
            setTimeout(() => {
                const updatedRect = target.getBoundingClientRect();
                this.popup.style.top = (updatedRect.bottom + 15) + 'px';
                // Center horizontally relative to target, clamp to screen
                let left = updatedRect.left + (updatedRect.width / 2) - 150;
                if (left < 10) left = 10;
                if (left + 300 > window.innerWidth) left = window.innerWidth - 310;
                this.popup.style.left = left + 'px';
                this.popup.style.transform = 'none';
            }, 300);

        } else {
            // Center if no target
            this.popup.style.top = '50%';
            this.popup.style.left = '50%';
            this.popup.style.transform = 'translate(-50%, -50%)';
        }

        // Bind Buttons (Re-bind every time innerHTML changes)
        const nextBtn = document.getElementById('tut-next-btn');
        const skipBtn = document.getElementById('tut-skip-btn');

        if (nextBtn) nextBtn.onclick = (e) => {
            e.stopPropagation(); // Prevent bubbling
            this.showStep(index + 1);
        };

        if (skipBtn) skipBtn.onclick = (e) => {
            e.stopPropagation();
            this.end();
        };

        this.currentStep = index;
    }

    end() {
        this.overlay.style.display = 'none';
        this.popup.style.display = 'none';
        localStorage.setItem('tutorial_completed', 'true');
        console.log("TutorialManager: Finished.");
    }
}

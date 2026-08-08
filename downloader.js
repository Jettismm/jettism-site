document.addEventListener('DOMContentLoaded', () => {
  const clipForm = document.getElementById('clip-form');
  const driveUrlInput = document.getElementById('drive-url');
  const startTimeInput = document.getElementById('start-time');
  const endTimeInput = document.getElementById('end-time');
  const submitBtn = document.getElementById('submit-btn');
  
  const statusContainer = document.getElementById('status-container');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const statusText = document.getElementById('status-text');
  const footerStatus = document.getElementById('footer-status');
  const apiWarning = document.getElementById('api-warning');

  // Config Status Card elements
  const configStatusCard = document.getElementById('config-status-card');
  const badgeApiKey = document.getElementById('badge-api-key');
  const badgeServiceAccount = document.getElementById('badge-service-account');
  const saDetailsSection = document.getElementById('sa-details-section');
  const saEmailInput = document.getElementById('sa-email-input');
  const copySaEmailBtn = document.getElementById('copy-sa-email-btn');
  const copyBtnText = document.getElementById('copy-btn-text');

  let pollInterval = null;

  // Check if server is configured
  fetch('/api/config')
    .then(r => r.json())
    .then(data => {
      // Manage main warning banner
      if (!data.hasApiKey && !data.hasServiceAccount) {
        apiWarning.classList.remove('hidden');
      } else {
        // Show status card if at least one auth option exists
        configStatusCard.classList.remove('hidden');
        
        // Update API Key badge
        if (data.hasApiKey) {
          badgeApiKey.classList.add('active');
          badgeApiKey.textContent = 'API Key: Connected';
        } else {
          badgeApiKey.classList.add('inactive');
          badgeApiKey.textContent = 'API Key: None';
        }

        // Update Service Account badge
        if (data.hasServiceAccount) {
          badgeServiceAccount.classList.add('active');
          badgeServiceAccount.textContent = 'Service Account: Connected';
          
          // Show details
          if (data.serviceAccountEmail) {
            saDetailsSection.classList.remove('hidden');
            saEmailInput.value = data.serviceAccountEmail;
          }
        } else {
          badgeServiceAccount.classList.add('inactive');
          badgeServiceAccount.textContent = 'Service Account: None';
        }
      }
    })
    .catch(() => {});

  // Copy Service Account Email click handler
  if (copySaEmailBtn && saEmailInput) {
    copySaEmailBtn.addEventListener('click', () => {
      const emailText = saEmailInput.value.trim();
      if (!emailText) return;

      navigator.clipboard.writeText(emailText)
        .then(() => {
          const originalText = copyBtnText.textContent;
          copyBtnText.textContent = 'Copied!';
          copySaEmailBtn.style.color = '#3bf09b';
          setTimeout(() => {
            copyBtnText.textContent = originalText;
            copySaEmailBtn.style.color = '';
          }, 2000);
        })
        .catch(err => {
          console.error('Failed to copy text: ', err);
          // Fallback selection copy
          saEmailInput.select();
          try {
            document.execCommand('copy');
            copyBtnText.textContent = 'Copied!';
            setTimeout(() => { copyBtnText.textContent = 'Copy'; }, 2000);
          } catch (e) {}
        });
    });
  }

  clipForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Reset UI state
    statusContainer.classList.remove('hidden', 'error');
    progressBarFill.style.width = '0%';
    statusText.textContent = 'Initializing task...';
    footerStatus.textContent = 'Processing request...';
    submitBtn.disabled = true;

    const driveUrl = driveUrlInput.value.trim();
    const startTime = startTimeInput.value.trim();
    const endTime = endTimeInput.value.trim();
    const quality = document.querySelector('input[name="quality"]:checked')?.value || 'standard';

    try {
      // 1. Send request to create the clipping task
      const response = await fetch('/api/clip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ driveUrl, startTime, endTime, quality })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to initiate clipping process.');
      }

      const { taskId } = data;
      
      // 2. Start polling for progress
      startPolling(taskId);

    } catch (err) {
      showError(err.message);
    }
  });

  function startPolling(taskId) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/status/${taskId}`);
        
        if (!response.ok) {
          throw new Error('Could not fetch task status.');
        }

        const task = await response.json();

        // Update UI with latest status
        statusText.textContent = task.statusMessage;
        progressBarFill.style.width = `${task.progress}%`;
        footerStatus.textContent = `Status: ${task.status}...`;

        if (task.status === 'completed') {
          clearInterval(pollInterval);
          progressBarFill.style.width = '100%';
          statusText.textContent = `Clip ready (${task.fileSize}). Starting download...`;
          footerStatus.textContent = "Everything's ready.";
          
          // Trigger file download
          triggerDownload(task.downloadUrl);
          
          // Enable button after brief pause
          setTimeout(() => {
            submitBtn.disabled = false;
          }, 3000);

        } else if (task.status === 'failed') {
          clearInterval(pollInterval);
          showError(task.error || 'Clipping failed.');
        }

      } catch (err) {
        clearInterval(pollInterval);
        showError(err.message);
      }
    }, 1000);
  }

  function showError(message) {
    statusContainer.classList.add('error');
    statusContainer.classList.remove('hidden');
    statusText.textContent = `Error: ${message}`;
    progressBarFill.style.width = '100%';
    footerStatus.textContent = 'Task failed.';
    submitBtn.disabled = false;
    
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  }

  function triggerDownload(downloadUrl) {
    // Elegant way to download a file without breaking browser context
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = downloadUrl;
    document.body.appendChild(iframe);
    
    // Clean up iframe after download starts
    setTimeout(() => {
      document.body.removeChild(iframe);
    }, 2000);
  }
});

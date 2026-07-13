import Head from 'next/head'
import { useEffect, useRef, useState } from 'react'

const SIGNAL_API = '/api/signal'
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]
const ALLOWED_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*'

const generateId = () =>
  Array.from({ length: 6 }, () => ALLOWED_ID_CHARS[Math.floor(Math.random() * ALLOWED_ID_CHARS.length)]).join('')

const isValidUserId = (value) => /^[A-Za-z0-9!@#$%^&*]{6}$/.test(value || '')

export default function Home() {
  const [userId, setUserId] = useState('')
  const [editableId, setEditableId] = useState('')
  const [remoteId, setRemoteId] = useState('')
  const [status, setStatus] = useState('Initializing...')
  const [incomingCaller, setIncomingCaller] = useState('')
  const [incomingOffer, setIncomingOffer] = useState(null)
  const [callActive, setCallActive] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState('default')
  const [errorMessage, setErrorMessage] = useState('')
  const [swStatus, setSwStatus] = useState('')
  const [isScreenSharing, setIsScreenSharing] = useState(false)

  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const screenStreamRef = useRef(null)
  const audioRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const ringtoneRef = useRef(null)
  const pendingCandidatesRef = useRef([])
  const pollingRef = useRef(null)
  const connectedPeerRef = useRef(null)
  const dataChannelRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const storedId = localStorage.getItem('pvcall-user-id')
    const nextId = storedId && isValidUserId(storedId) ? storedId : generateId()
    localStorage.setItem('pvcall-user-id', nextId)
    setUserId(nextId)
    setEditableId(nextId)
    setNotificationPermission(Notification.permission)
    setStatus(`Ready as ${storedId}`)

    pollingRef.current = window.setInterval(() => {
      pollSignals(storedId)
    }, 900)

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then(() => setSwStatus('PWA service worker registered'))
        .catch(() => setSwStatus('PWA service worker failed to register'))
    }

    return () => {
      window.clearInterval(pollingRef.current)
      cleanupCall('Reloading page')
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const sendSignal = async (to, message) => {
    await fetch(SIGNAL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ to, from: userId, message }),
      cache: 'no-store',
    })
  }

  const pollSignals = async (peerId) => {
    try {
      const response = await fetch(`${SIGNAL_API}?peerId=${encodeURIComponent(peerId)}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-store' },
      })
      const messages = await response.json()
      messages.forEach(handleSignal)
    } catch (error) {
      console.error('Signal polling failed', error)
    }
  }

  const handleSignal = async ({ from, message }) => {
    if (!message || !message.type) return

    if (message.type === 'offer') {
      if (callActive || incomingOffer) {
        await sendSignal(from, { type: 'busy' })
        return
      }
      setIncomingCaller(from)
      setIncomingOffer(message.sdp)
      setStatus(`Incoming call from ${from}`)
      requestNotificationPermission()
      showIncomingNotification(from)
      playRingtone()
      pendingCandidatesRef.current = []
      return
    }

    if (message.type === 'answer' && pcRef.current) {
      await pcRef.current.setRemoteDescription(message.sdp)
      pendingCandidatesRef.current.forEach((candidate) => pcRef.current.addIceCandidate(candidate))
      pendingCandidatesRef.current = []
      return
    }

    if (message.type === 'ice') {
      if (!message.candidate) return
      const candidate = new RTCIceCandidate(message.candidate)
      if (pcRef.current) {
        await pcRef.current.addIceCandidate(candidate)
      } else {
        pendingCandidatesRef.current.push(candidate)
      }
      return
    }

    if (message.type === 'bye') {
      cleanupCall(`${from} ended the call`)
      return
    }

    if (message.type === 'busy') {
      setStatus(`${from} is busy`)
      setCallActive(false)
      return
    }
  }

  const getLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      localStreamRef.current = stream
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
        localVideoRef.current.muted = true
      }
      return stream
    } catch (error) {
      setErrorMessage('Camera and microphone access are required for video calls.')
      throw error
    }
  }

  const createPeerConnection = (remotePeerId) => {
    cleanupCall('Starting new connection')

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && remotePeerId) {
        const serializedCandidate = candidate.toJSON ? candidate.toJSON() : candidate
        sendSignal(remotePeerId, { type: 'ice', candidate: serializedCandidate })
      }
    }

    pc.ontrack = (event) => {
      const incomingStream = event.streams[0]
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = incomingStream
      }
      if (audioRef.current) {
        audioRef.current.srcObject = incomingStream
        audioRef.current.play().catch(() => {})
      }
      setCallActive(true)
      setStatus(`In call with ${remotePeerId}`)
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupCall('Connection ended')
      }
    }

    pc.ondatachannel = (event) => {
      const channel = event.channel
      dataChannelRef.current = channel
      channel.onmessage = handleDataChannelMessage
    }

    const dataChannel = pc.createDataChannel('pvcall')
    dataChannel.onmessage = handleDataChannelMessage
    dataChannelRef.current = dataChannel

    pcRef.current = pc
    connectedPeerRef.current = remotePeerId
    return pc
  }

  const handleDataChannelMessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === 'bye') {
        cleanupCall('Remote ended the call')
      }
    } catch (error) {
      console.error('Invalid data channel message', error)
    }
  }

  const playRingtone = () => {
    if (ringtoneRef.current) return
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return

    const audioCtx = new AudioContext()
    const oscillator = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 420
    gain.gain.value = 0.12
    oscillator.connect(gain).connect(audioCtx.destination)
    oscillator.start()

    ringtoneRef.current = { audioCtx, oscillator }
  }

  const stopRingtone = () => {
    if (!ringtoneRef.current) return
    ringtoneRef.current.oscillator.stop()
    ringtoneRef.current.audioCtx.close()
    ringtoneRef.current = null
  }

  const showIncomingNotification = (callerId) => {
    if (Notification.permission !== 'granted') return
    new Notification('PVCall incoming call', {
      body: `Call from ${callerId}`,
      icon: '/icon.svg',
    })
  }

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) return
    const permission = await Notification.requestPermission()
    setNotificationPermission(permission)
  }

  const startCall = async () => {
    setErrorMessage('')
    const targetId = remoteId.trim()
    if (!targetId) {
      setErrorMessage('Enter the other user’s ID to start a call.')
      return
    }
    if (targetId === userId) {
      setErrorMessage('Cannot call your own ID.')
      return
    }

    try {
      const stream = await getLocalStream()
      const pc = createPeerConnection(targetId)
      stream.getTracks().forEach((track) => pc.addTrack(track, stream))

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await sendSignal(targetId, { type: 'offer', sdp: offer })
      setCallActive(true)
      setStatus(`Calling ${targetId}...`)
    } catch (error) {
      setErrorMessage('Unable to start call. Check camera and microphone permissions.')
    }
  }

  const answerCall = async () => {
    if (!incomingCaller || !incomingOffer) return
    stopRingtone()

    try {
      const stream = await getLocalStream()
      const pc = createPeerConnection(incomingCaller)
      stream.getTracks().forEach((track) => pc.addTrack(track, stream))

      await pc.setRemoteDescription(incomingOffer)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await sendSignal(incomingCaller, { type: 'answer', sdp: answer })

      setIncomingCaller('')
      setIncomingOffer(null)
      setCallActive(true)
      setStatus(`In call with ${incomingCaller}`)
    } catch (error) {
      setErrorMessage('Unable to answer call. Check camera and microphone permissions.')
    }
  }

  const rejectCall = async () => {
    if (!incomingCaller) return
    stopRingtone()
    await sendSignal(incomingCaller, { type: 'bye' })
    setIncomingCaller('')
    setIncomingOffer(null)
    setStatus('Incoming call declined')
  }

  const toggleScreenShare = async () => {
    if (!pcRef.current || !localStreamRef.current) return

    try {
      if (isScreenSharing && screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => track.stop())
        screenStreamRef.current = null
        const sender = pcRef.current.getSenders().find((entry) => entry.track?.kind === 'video')
        if (sender && localStreamRef.current.getVideoTracks()[0]) {
          await sender.replaceTrack(localStreamRef.current.getVideoTracks()[0])
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current
        }
        setIsScreenSharing(false)
        setStatus('Screen share stopped')
        return
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const videoTrack = displayStream.getVideoTracks()[0]
      const sender = pcRef.current.getSenders().find((entry) => entry.track?.kind === 'video')
      if (sender && videoTrack) {
        await sender.replaceTrack(videoTrack)
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = displayStream
      }
      screenStreamRef.current = displayStream
      setIsScreenSharing(true)
      setStatus('Screen sharing active')
      displayStream.getVideoTracks()[0].addEventListener('ended', () => {
        toggleScreenShare()
      })
    } catch (error) {
      setErrorMessage('Unable to share your screen.')
    }
  }

  const cleanupCall = (message) => {
    if (dataChannelRef.current?.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify({ type: 'bye' }))
    }

    if (pcRef.current) {
      pcRef.current.onicecandidate = null
      pcRef.current.ontrack = null
      pcRef.current.ondatachannel = null
      pcRef.current.onconnectionstatechange = null
      pcRef.current.close()
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop())
      screenStreamRef.current = null
    }

    pcRef.current = null
    dataChannelRef.current = null
    connectedPeerRef.current = null
    pendingCandidatesRef.current = []
    setCallActive(false)
    setIncomingCaller('')
    setIncomingOffer(null)
    setIsScreenSharing(false)
    setStatus(message || `Ready as ${userId}`)
    stopRingtone()
  }

  const endCall = async () => {
    if (connectedPeerRef.current) {
      await sendSignal(connectedPeerRef.current, { type: 'bye' })
    }
    cleanupCall('Call ended')
  }

  const saveUserId = () => {
    const nextId = editableId.trim()
    if (!isValidUserId(nextId)) {
      setErrorMessage('User ID must be exactly 6 characters using letters, numbers, or symbols.')
      return
    }
    localStorage.setItem('pvcall-user-id', nextId)
    setUserId(nextId)
    setStatus(`Your ID is now ${nextId}`)
    setErrorMessage('')
  }

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(userId)
    setStatus('Your ID has been copied to clipboard')
  }

  return (
    <>
      <Head>
        <title>PVCall</title>
        <meta name="description" content="Minimal browser calling experience with clean design." />
        <meta name="theme-color" content="#f5f7f8" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon.svg" />
      </Head>

      <main style={styles.page}>
        <section style={styles.card}>
          <div style={styles.header}>
            <span style={styles.icon}>📞</span>
            <div>
              <h1 style={styles.title}>PVCall</h1>
              <p style={styles.subtitle}>A clean peer-to-peer calling experience.</p>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionIcon}>🆔</span>
              <span style={styles.sectionTitle}>Your call ID</span>
            </div>
            <div style={styles.idBox}>
              <code style={styles.id}>{userId || 'Loading...'}</code>
              <button style={styles.button} type="button" onClick={copyToClipboard}>
                Copy
              </button>
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={editableId}
                onChange={(event) => setEditableId(event.target.value)}
                placeholder="Choose a custom ID"
              />
              <button style={styles.subtleButton} type="button" onClick={saveUserId}>
                Save ID
              </button>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionIcon}>📹</span>
              <span style={styles.sectionTitle}>Video call</span>
            </div>
            <div style={styles.videoGrid}>
              <div style={styles.videoBox}>
                <video ref={localVideoRef} autoPlay playsInline muted style={styles.video} />
                <span style={styles.videoLabel}>You</span>
              </div>
              <div style={styles.videoBox}>
                <video ref={remoteVideoRef} autoPlay playsInline style={styles.video} />
                <span style={styles.videoLabel}>Remote</span>
              </div>
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={remoteId}
                onChange={(event) => setRemoteId(event.target.value)}
                placeholder="Enter recipient ID"
              />
              <button style={styles.button} type="button" onClick={startCall} disabled={callActive}>
                Call
              </button>
            </div>
            {callActive && (
              <div style={styles.actionRow}>
                <button style={styles.subtleButton} type="button" onClick={toggleScreenShare}>
                  {isScreenSharing ? 'Stop sharing' : 'Share screen'}
                </button>
              </div>
            )}
          </div>

          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionIcon}>🔔</span>
              <span style={styles.sectionTitle}>Notifications</span>
            </div>
            <p style={styles.small}>
              {notificationPermission === 'granted'
                ? 'Incoming call alerts are enabled.'
                : 'Enable notifications for callers.'}
            </p>
            {notificationPermission !== 'granted' && (
              <button style={styles.subtleButton} type="button" onClick={requestNotificationPermission}>
                Enable
              </button>
            )}
          </div>

          {incomingCaller && (
            <div style={styles.incoming}>
              <p style={styles.incomingText}>Incoming call from <strong>{incomingCaller}</strong></p>
              <div style={styles.actionRow}>
                <button style={styles.button} type="button" onClick={answerCall}>
                  Answer
                </button>
                <button style={styles.dangerButton} type="button" onClick={rejectCall}>
                  Decline
                </button>
              </div>
            </div>
          )}

          {callActive && (
            <div style={styles.section}>
              <button style={styles.dangerButton} type="button" onClick={endCall}>
                End Call
              </button>
            </div>
          )}

          <div style={styles.footer}>
            <p style={styles.status}>{status}</p>
            {errorMessage && <p style={styles.error}>{errorMessage}</p>}
          </div>
        </section>
      </main>

      <audio ref={audioRef} hidden />
    </>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    padding: '2rem',
    background: '#f5f7f8',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    color: '#111827',
  },
  card: {
    width: '100%',
    maxWidth: '640px',
    padding: '2rem',
    borderRadius: '24px',
    background: '#ffffff',
    boxShadow: '0 20px 45px rgba(15, 23, 42, 0.08)',
    border: '1px solid rgba(15, 23, 42, 0.08)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '1.5rem',
  },
  icon: {
    fontSize: '2rem',
    background: '#e2e8f0',
    width: '3rem',
    height: '3rem',
    borderRadius: '16px',
    display: 'grid',
    placeItems: 'center',
  },
  title: {
    margin: 0,
    fontSize: '2rem',
    lineHeight: 1.1,
  },
  subtitle: {
    margin: '0.35rem 0 0',
    color: '#475569',
    fontSize: '1rem',
  },
  section: {
    marginBottom: '1.5rem',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '0.75rem',
  },
  sectionIcon: {
    fontSize: '1.2rem',
  },
  sectionTitle: {
    fontWeight: 600,
    color: '#111827',
  },
  idBox: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  id: {
    padding: '0.9rem 1rem',
    borderRadius: '14px',
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    color: '#0f172a',
    flex: 1,
    minWidth: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    borderRadius: '14px',
    border: '1px solid #e2e8f0',
    background: '#f8fafc',
    color: '#111827',
    padding: '0.95rem 1rem',
    fontSize: '1rem',
  },
  button: {
    borderRadius: '14px',
    border: 'none',
    padding: '0.95rem 1.25rem',
    background: '#111827',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '1rem',
    minWidth: '92px',
  },
  subtleButton: {
    borderRadius: '14px',
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    cursor: 'pointer',
    padding: '0.9rem 1.1rem',
    fontSize: '0.95rem',
  },
  dangerButton: {
    borderRadius: '14px',
    border: 'none',
    padding: '0.95rem 1.25rem',
    background: '#ef4444',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '1rem',
  },
  row: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
    marginTop: '0.75rem',
  },
  videoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '0.75rem',
    marginBottom: '0.75rem',
  },
  videoBox: {
    borderRadius: '16px',
    overflow: 'hidden',
    background: '#0f172a',
    border: '1px solid #e2e8f0',
    minHeight: '180px',
    position: 'relative',
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    background: '#0f172a',
  },
  videoLabel: {
    position: 'absolute',
    left: '0.6rem',
    bottom: '0.6rem',
    background: 'rgba(15, 23, 42, 0.7)',
    color: '#fff',
    padding: '0.3rem 0.6rem',
    borderRadius: '999px',
    fontSize: '0.8rem',
  },
  footer: {
    marginTop: '1rem',
    display: 'grid',
    gap: '0.5rem',
  },
  status: {
    margin: 0,
    color: '#475569',
  },
  small: {
    color: '#475569',
    margin: 0,
    lineHeight: 1.6,
  },
  error: {
    color: '#b91c1c',
    margin: 0,
  },
  incoming: {
    borderRadius: '18px',
    padding: '1rem',
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
  },
  incomingText: {
    margin: 0,
    color: '#111827',
  },
  actionRow: {
    display: 'flex',
    gap: '0.75rem',
    marginTop: '0.75rem',
  },
}

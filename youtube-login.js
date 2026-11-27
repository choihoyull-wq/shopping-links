(() => {
  async function call(brand, action, extra = {}) {
    const { data, error } = await db.functions.invoke('youtube-session', { body: { brand, action, ...extra } })
    if (error) {
      const response = await error.context?.json?.().catch(() => null)
      const failure = new Error(response?.error || '저장된 YouTube 연결 서버에 접근할 수 없습니다.')
      failure.status = error.context?.status
      throw failure
    }
    return data
  }

  window.createYouTubeLogin = ({ fixed, g, restoreLocal, getSession, setSession, show, tick, publishChannel, accountAllowed }) => {
    let restoring
    let lastRestore
    let retryAfter = 0
    let popup
    let attempt
    let generation = 0
    let suspended = false
    db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
        suspended = event === 'SIGNED_OUT'
        lastRestore = undefined
      }
    })
    const key = (user = currentUser?.id) => `youtubeOfflineV1:${user}:${fixed}`
    const preferences = () => {
      try { return JSON.parse(localStorage.getItem(key())) || {} } catch { return {} }
    }
    const update = (data) => localStorage.setItem(key(), JSON.stringify({ ...preferences(), ...data }))
    const checkbox = g('ytRemember')
    const change = g('ytAccountChange')
    const disconnect = g('ytDisconnect')
    const label = g('ytKeepStatus')
    const message = (value) => { label.textContent = value }
    function apply(session, user, replace = false) {
      if (currentUser?.id !== user || !session) return false
      if (!accountAllowed(session.id, replace)) throw new Error('저장된 채널이 기존 채널 연결과 다릅니다.')
      const current = getSession()
      const running = Boolean(session.wanted && !preferences().paused)
      const next = { ...session, running }
      if (current?.durable && current.id === next.id) Object.assign(current, next)
      else setSession(next)
      publishChannel(next)
      message(`연결 유지 중 · ${next.title}`)
      show()
      if (running && !replace) tick()
      return true
    }
    function restore() {
      const user = currentUser?.id
      if (!user || suspended || !restoreLocal()) return
      checkbox.checked = Boolean(preferences().enabled)
      if (!checkbox.checked || restoring || lastRestore === user || Date.now() < retryAfter) return
      lastRestore = user
      const request = generation
      restoring = call(fixed, 'session').then(({ session }) => {
        if (request === generation && !apply(session, user)) message('저장된 연결 없음 · Google 계정을 연결해 주세요.')
      }).catch((error) => {
        if (request === generation) message(error.message)
        if (request === generation && ![401, 409].includes(error.status)) {
          lastRestore = undefined
          retryAfter = Date.now() + 60000
        }
      }).finally(() => { restoring = undefined })
    }
    async function refresh(expiry) {
      const user = currentUser?.id
      const request = generation
      const { session } = await call(fixed, 'session', expiry ? { rejectedExpiry: expiry } : {})
      if (request !== generation || !apply(session, user)) throw new Error('저장된 YouTube 연결이 없습니다. 다시 연결해 주세요.')
      return getSession()
    }
    async function login(replace) {
      if (!currentUser || attempt) return
      if (replace && !confirm('이 쇼핑 채널의 YouTube 계정을 변경할까요? 채널이 바뀌면 자동 답글은 다시 시작해야 합니다.')) return
      const user = currentUser.id
      const request = ++generation
      popup = window.open('about:blank', `youtube-oauth-${fixed}`, 'popup,width=620,height=760')
      if (!popup) { message('팝업을 허용한 뒤 다시 연결해 주세요.'); return }
      popup.opener = null
      try {
        const { url, linkId } = await call(fixed, 'start', { expected: accountAllowed(), wanted: Boolean(getSession()?.wanted), change: replace })
        if (currentUser?.id !== user || request !== generation) { popup.close(); return }
        const google = new URL(url)
        if (google.origin !== 'https://accounts.google.com') throw new Error('Google 승인 주소가 올바르지 않습니다.')
        popup.location = google.href
        message('Google 승인 후 유튜브 연결 창을 닫아 주세요.')
        const expires = Date.now() + 300000
        attempt = setInterval(async () => {
          if (popup && !popup.closed && Date.now() < expires && currentUser?.id === user) return
          clearInterval(attempt)
          attempt = null
          if (request !== generation || currentUser?.id !== user) return
          try {
            const { session } = await call(fixed, 'session')
            if (request !== generation || currentUser?.id !== user) return
            if (!session || session.linkId !== linkId) { message('Google 인증이 완료되지 않았습니다.'); return }
            const changed = accountAllowed() && accountAllowed() !== session.id
            update({ enabled: true, ...(changed ? { paused: true } : {}) })
            lastRestore = user
            apply(session, user, replace)
          } catch (error) { message(error.message) }
        }, 1000)
      } catch (error) {
        popup.close()
        message(error.message)
      }
    }
    async function logout(fromAdmin = false) {
      if (fromAdmin) suspended = true
      generation++
      clearInterval(attempt)
      attempt = null
      popup?.close()
      lastRestore = undefined
      retryAfter = 0
    }
    async function forget() {
      const user = currentUser?.id
      if (!user) return
      const stored = preferences().enabled || getSession()?.durable
      await logout()
      const request = generation
      const old = getSession()
      if (old) old.running = false
      setSession(null)
      update({ enabled: false, paused: true })
      checkbox.checked = false
      show()
      if (!stored) { message('이 채널의 YouTube 연결을 해제했습니다.'); return }
      try {
        await call(fixed, 'disconnect')
        if (request === generation && currentUser?.id === user) message('이 채널의 저장된 YouTube 연결을 해제했습니다.')
      } catch (error) {
        if (request === generation && currentUser?.id === user) message(`이 브라우저에서 자동 연결을 중지했습니다. 서버 연결 해제 실패 · ${error.message}`)
      }
    }
    checkbox.onchange = () => {
      if (checkbox.checked) { update({ enabled: true }); message('Google 연결 버튼을 눌러 한 번 승인해 주세요.') }
      else if (getSession()?.durable || preferences().enabled) void forget()
    }
    change.onclick = () => { if (checkbox.checked) void login(true); else message('자동 로그인 유지를 선택한 뒤 계정을 변경해 주세요.') }
    disconnect.onclick = () => void forget()
    return {
      restore, refresh, login, logout,
      persistent: () => checkbox.checked,
      async wanted(value) {
        if (!getSession()?.durable) return
        if (!value) update({ paused: true })
        await call(fixed, 'wanted', { wanted: value })
        if (value) update({ paused: false })
      },
    }
  }
})()

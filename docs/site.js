/*
  复制按钮。同源、无依赖 —— 页面一个外部请求都不发（中英两版共用这一份），
  这条由 test/site-numbers.test.mjs 钉着。

  clipboard API 在非安全上下文（比如有人把这个文件用 file:// 打开）里是
  undefined，所以要有退路：失败就把命令选中，人按 ⌘C 也能走完。
  静默失败是这个项目最不能接受的形态。
*/
document.querySelectorAll('.cmd .copy').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var cmd = btn.dataset.cmd
    var done = function () {
      btn.textContent = 'Copied'
      btn.setAttribute('data-done', '')
      setTimeout(function () {
        btn.textContent = 'Copy'
        btn.removeAttribute('data-done')
      }, 1600)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(done, select)
    } else {
      select()
    }
    function select () {
      var code = btn.parentNode.querySelector('code')
      var r = document.createRange()
      r.selectNodeContents(code)
      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
      btn.textContent = 'Press ⌘C'
      setTimeout(function () { btn.textContent = 'Copy' }, 2200)
    }
  })
})

Pod::Spec.new do |s|
  s.name           = 'TerminalInput'
  s.version        = '0.1.0'
  s.summary        = 'Terminal text input that reports IME composition'
  s.description    = 'A text view for Panecast that only hands text to JavaScript once the input method has committed it.'
  s.author         = ''
  s.homepage       = 'https://github.com/nlamps99/panecast'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

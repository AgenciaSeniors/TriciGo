Pod::Spec.new do |s|
  s.name           = 'DriverOverlay'
  s.version        = '1.0.0'
  s.summary        = 'Android-only overlay bubble + background app launch (iOS no-op stubs)'
  s.description    = 'Floating bubble over other apps and background activity launch for ride offers. iOS ships no-op stubs.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

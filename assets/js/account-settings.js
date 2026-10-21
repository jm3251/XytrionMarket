(function (global) {
  'use strict';
  function alertUser(title, text, icon) {
    if (global.Swal) return global.Swal.fire({ title: title, text: text, icon: icon || 'info', confirmButtonColor: '#2563eb' });
    global.alert(title + ': ' + text); return Promise.resolve();
  }
  function captureSubmit(form, handler) {
    if (!form) return;
    form.addEventListener('submit', function (event) { event.preventDefault(); event.stopImmediatePropagation(); handler(form); }, true);
  }
  async function saveProfile(form) {
    var alpineData = global.Alpine && typeof global.Alpine.$data === 'function' ? global.Alpine.$data(form) : null;
    if ((alpineData && alpineData.saving) || form.__profileSaveInFlight) return;
    form.__profileSaveInFlight = true;
    if (alpineData) alpineData.saving = true;
    var submit = form.querySelector('[type="submit"]');
    try {
      var data = await global.XytrionApi.request('/api/account', { method: 'PATCH', body: {
        name: form.elements.name.value, phone: form.elements.phone.value, country: form.elements.country.value
      } });
      localStorage.setItem('xytrion_current_user', JSON.stringify(data.user)); global.hydrateUserProfile(data.user);
      await alertUser('Profile Updated', 'Your personal information was saved.', 'success');
    } catch (error) { await alertUser('Update Failed', error.message, 'error'); }
    finally {
      form.__profileSaveInFlight = false;
      if (alpineData) alpineData.saving = false;
      if (submit) submit.disabled = false;
    }
  }
  async function changePassword(form) {
    var submit = form.querySelector('[type="submit"]'); if (submit) submit.disabled = true;
    try {
      var data = await global.XytrionApi.request('/api/auth/change-password', { method: 'POST', body: {
        currentPassword: form.elements.current_password.value,
        newPassword: form.elements.password.value,
        confirmPassword: form.elements.password_confirmation.value
      } });
      form.reset(); await alertUser('Password Updated', data.message, 'success');
    } catch (error) { await alertUser('Password Update Failed', error.message, 'error'); }
    finally { if (submit) submit.disabled = false; }
  }
  function injectDeleteCard() {
    if (document.getElementById('delete-account-card')) return;
    var content = document.querySelector('[x-show="activeTab === \'pas\'"]'); if (!content) return;
    var card = document.createElement('div'); card.id = 'delete-account-card'; card.className = 'mt-8 p-6 bg-red-950/30 border border-red-700/50 rounded-2xl';
    card.innerHTML = '<h3 class="text-lg font-semibold text-red-300 mb-2">Delete Account</h3><p class="text-sm text-gray-300 mb-4">This permanently disables sign-in, removes chat records, redacts withdrawal destinations, and retains financial ledger records required for audit integrity.</p><button type="button" id="delete-account-button" class="px-5 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-medium">Delete My Account</button>';
    content.appendChild(card);
    document.getElementById('delete-account-button').addEventListener('click', deleteAccount);
  }
  async function deleteAccount() {
    var result = global.Swal ? await global.Swal.fire({
      title: 'Delete account permanently?',
      html: '<p style="margin-bottom:12px">This action cannot be undone. Enter your password and type <strong>DELETE</strong>.</p><input id="delete-password" type="password" class="swal2-input" placeholder="Current password"><input id="delete-confirmation" class="swal2-input" placeholder="Type DELETE">',
      icon: 'warning', showCancelButton: true, confirmButtonText: 'Delete Account', confirmButtonColor: '#dc2626',
      preConfirm: function () { return { password: document.getElementById('delete-password').value, confirmation: document.getElementById('delete-confirmation').value }; }
    }) : { isConfirmed: global.confirm('Delete your account permanently?'), value: { password: global.prompt('Current password:'), confirmation: global.prompt('Type DELETE:') } };
    if (!result.isConfirmed) return;
    try {
      await global.XytrionApi.request('/api/account', { method: 'DELETE', body: result.value });
      localStorage.clear(); global.location.replace('../index.html');
    } catch (error) { await alertUser('Deletion Failed', error.message, 'error'); }
  }
  document.addEventListener('DOMContentLoaded', function () {
    captureSubmit(document.getElementById('updateprofileform'), saveProfile);
    var passwordInput = document.getElementById('current_password');
    captureSubmit(passwordInput && passwordInput.closest('form'), changePassword);
    injectDeleteCard();
  });
})(window);
